# Track 4 — Database & Schema Audit · abc-helper-app

**Scope:** authoritative schema = the migration SQL in `supabase/migrations/`. Every claim cites `table.column` + `file:line`. Labels: **OBSERVED** (read directly in SQL), **INFERRED** (derived from SQL + app code), **ASSUMPTION** (unresolved). App-code cross-refs come from `src/db/queries/*`, `src/db/clients/*`, and `src/server/actions/*` (read-only).

Convention: links point at the migration line, e.g. [baseline:633](supabase/migrations/00000000000001_baseline_abc_schema.sql#L633).

**Headline findings (detail in §5 and §7):**
1. **`api_tokens` and `app_secrets` have RLS enabled but ZERO policies** → no `authenticated` role can read them (good), but this is *implicit* deny via missing policy, not an explicit one. They are reached only by the service-role client. OBSERVED [baseline:1562](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1562)–[1565](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1565).
2. **`audit_log` RLS policy is `FOR ALL`** (USING/WITH CHECK both `is_company_admin(company_id)`) — a scoped admin could UPDATE/DELETE their company's trail at the DB level; this was the gap migration `..05` patched with an append-only *trigger* (not an RLS fix). OBSERVED [baseline:1571](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1571), [audit_log_append_only:26](supabase/migrations/00000000000005_audit_log_append_only.sql#L26).
3. **Several policies grant access on a *company-blind* `is_admin()` check** (`agreement_templates`, `announcements`, `portal_settings`, `workers_admin_insert`) — any admin of any company can write these. For singletons/global config this is acceptable; for `workers` insert it means a client-admin can create a worker row (see §5b). OBSERVED [baseline:1543](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1543), [1758](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1758).
4. **No money/ratio CHECK constraints** anywhere on `payments`, `rates`, `invoices`, `invoice_lines` (negatives, ratio bounds, subtotal sanity). OBSERVED — see §4.
5. **Migration-hygiene defect:** a byte-identical untracked duplicate `00000000000013_contract_type_per_hour_session 2.sql` sits in the migrations dir (a Finder copy). It is `git status ??` (untracked) and `diff` reports IDENTICAL. Harmless if applied (idempotent `ADD VALUE IF NOT EXISTS`) but it pollutes the ordered migration set and should be deleted. OBSERVED.

---

## §1 Table inventory (28 tables)

PKs and key columns are OBSERVED from the baseline DDL unless noted. "Goal" maps to the system goals (time→payroll→Wise; employer/client; onboarding/e-sign; doc review; time approval; invoicing; portal self-service).

### Identity / tenancy

| Table | PK | Key columns (type) | Purpose / goal |
|---|---|---|---|
| **companies** | `id` uuid | `name` text UNIQUE, `kind` text DEFAULT `'client'` CHECK in (`employer`,`client`), `status` company_status, `hubstaff_org_id` bigint, `contacts` jsonb, `tax_id`, `address`, `phone`, `website` | The tenant table. `kind='employer'` = the payroll org; `kind='client'` = billing tags. OBSERVED [baseline:633](supabase/migrations/00000000000001_baseline_abc_schema.sql#L633)–[646](supabase/migrations/00000000000001_baseline_abc_schema.sql#L646). |
| **admin_users** | `user_id` uuid (→`auth.users`) | `email` text UNIQUE, `role` text CHECK in (`owner`,`admin`), `name`, `can_countersign` bool | Identity/role for back-office admins. Owner = superuser. OBSERVED [baseline:556](supabase/migrations/00000000000001_baseline_abc_schema.sql#L556)–[565](supabase/migrations/00000000000001_baseline_abc_schema.sql#L565). |
| **admin_companies** | (`admin_email`,`company_id`) | `added_by` uuid | Junction: which companies a *non-owner* admin may see. Keyed by **email**, not `user_id` (loose coupling). OBSERVED [baseline:545](supabase/migrations/00000000000001_baseline_abc_schema.sql#L545)–[550](supabase/migrations/00000000000001_baseline_abc_schema.sql#L550), [1085](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1085). |
| **pending_admins** | `email` | `role` CHECK in (`owner`,`admin`) | Invite staging; `bind_pending_admin()` trigger promotes to `admin_users` on first sign-in. OBSERVED [baseline:901](supabase/migrations/00000000000001_baseline_abc_schema.sql#L901), [283](supabase/migrations/00000000000001_baseline_abc_schema.sql#L283). |
| **contractor_logins** | `worker_id` uuid (→`workers`) | `auth_user_id` uuid UNIQUE (→`auth.users`), `email`, `status` text DEFAULT `'active'` | Maps an auth user to a worker for portal self-service. `my_worker_id()` resolves caller→worker via this. OBSERVED [baseline:660](supabase/migrations/00000000000001_baseline_abc_schema.sql#L660), [431](supabase/migrations/00000000000001_baseline_abc_schema.sql#L431). |
| **workers** | `id` uuid | `first_name`,`last_name` NOT NULL, `match_key` GENERATED STORED (lower+trim concat), PII bundle (`email`,`mobile`,`date_of_birth`,`ph_address`,`permanent_address`,`postal_code`,`marital_status`,…), payout (`payout_method`,`payout_account` jsonb,`gcash`,`paymaya`,`paypal`,`wise_recipients` jsonb,`wise_recipient_id`), `photo_url`, `profile_extras` jsonb, `created_by` DEFAULT `auth.uid()` | Contractor master record. Core of payroll + onboarding + portal. OBSERVED [baseline:1035](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1035)–[1078](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1078). |
| **worker_companies** | `id` uuid; UNIQUE (`worker_id`,`company_id`) | `contract` contract_type DEFAULT `'FT'`, `status` worker_status, `hubstaff_user_id` bigint, `bill_rate_usd` numeric(12,2), `session_rate_usd` numeric(12,2) (added ..11), `weekly_hours` | The worker↔company assignment + per-client billing rates. The pivot that re-attributes employer time to a client for invoicing. OBSERVED [baseline:996](supabase/migrations/00000000000001_baseline_abc_schema.sql#L996)–[1009](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1009), [per_session_billing:18](supabase/migrations/00000000000011_per_session_billing.sql#L18). |

### Payroll

| Table | PK | Key columns | Purpose / goal |
|---|---|---|---|
| **rates** | `id` uuid | `worker_id`,`company_id` NOT NULL, `amount_php` numeric(12,2) NOT NULL, `period_basis` text DEFAULT `'semi_monthly'`, `effective_start` date NOT NULL, `effective_end` date, CHECK `effective_end IS NULL OR >= effective_start` | Effective-dated PHP pay rate per worker/company. Feeds payroll calc. OBSERVED [baseline:939](supabase/migrations/00000000000001_baseline_abc_schema.sql#L939)–[950](supabase/migrations/00000000000001_baseline_abc_schema.sql#L950). |
| **pay_periods** | `id` uuid; UNIQUE (`company_id`,`period_start`,`period_end`) | `state` pay_period_state (`open`/`locked`/`paid`), `expected_hours_ft` DEFAULT 80, `expected_hours_pt` DEFAULT 40, CHECK `period_end >= period_start` | Payroll window per company. OBSERVED [baseline:844](supabase/migrations/00000000000001_baseline_abc_schema.sql#L844)–[856](supabase/migrations/00000000000001_baseline_abc_schema.sql#L856). |
| **payments** | `id` uuid; UNIQUE (`pay_period_id`,`worker_id`) | full pay breakdown: `gross_php`,`health_allowance_php`,`thirteenth_month_php`,`shortfall_php`,`pdd_lunch_php`,`bonus_php`,`net_php`,`original_net_php`; `misc_items` jsonb CHECK `jsonb_typeof=array`; `fx_rate`,`payout_currency`,`payout_amount`,`payout_method`,`wise_transfer_id`,`wise_dates` jsonb,`wise_locked_at`; `status` payment_status | One payout per worker per period. Locked rows are immutable via `payments_lock_enforce()` trigger. OBSERVED [baseline:862](supabase/migrations/00000000000001_baseline_abc_schema.sql#L862)–[892](supabase/migrations/00000000000001_baseline_abc_schema.sql#L892), trigger [1356](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1356). |

### Time

| Table | PK | Key columns | Purpose / goal |
|---|---|---|---|
| **time_entries** | `id` uuid; UNIQUE (`company_id`,`source_name`,`work_date`) | `worker_id` (nullable), `source_name` text NOT NULL, `tracked_seconds` int, `pto_seconds` int, `activity_pct` numeric(5,2), `approval` approval_status, `pay_period_id`, `import_batch_id` | Hubstaff-imported daily time, matched to a worker by `source_name`. `company_id` = **employer** (re-attributed to client for invoicing). OBSERVED [baseline:956](supabase/migrations/00000000000001_baseline_abc_schema.sql#L956)–[972](supabase/migrations/00000000000001_baseline_abc_schema.sql#L972); employer note [per_session_billing:6](supabase/migrations/00000000000011_per_session_billing.sql#L6). |
| **hubstaff_projects** | `hubstaff_project_id` bigint | `company_id` NOT NULL, `org_id` bigint, `name` | Project→company mapping for ingest. OBSERVED [baseline:697](supabase/migrations/00000000000001_baseline_abc_schema.sql#L697)–[704](supabase/migrations/00000000000001_baseline_abc_schema.sql#L704). |
| **service_sessions** *(added ..11)* | `id` uuid | `company_id` NOT NULL = the **client** (≠ time_entries), `worker_id`, `session_date` date NOT NULL, `session_type`, `units` int CHECK `>=0`, `child_initials`,`eiid` (added ..12), `case_ref`,`notes`, `approval` approval_status, `import_batch_id`,`external_ref`, `created_by` DEFAULT `auth.uid()` | Flat-fee-per-session billing log (Early-Intervention sessions). Contractor-submittable from portal. OBSERVED [per_session_billing:22](supabase/migrations/00000000000011_per_session_billing.sql#L22)–[38](supabase/migrations/00000000000011_per_session_billing.sql#L38), [session_ei_fields_portal:13](supabase/migrations/00000000000012_session_ei_fields_portal.sql#L13). |

### Invoicing

| Table | PK | Key columns | Purpose / goal |
|---|---|---|---|
| **invoices** | `id` uuid | `company_id` NOT NULL (= client), `period_start/end` date NOT NULL, `invoice_no` text, `status` text DEFAULT `'draft'`, `subtotal_usd`,`total_usd`,`markup_pct`,`currency` DEFAULT `'USD'`, `created_by` | Client invoice header. `invoice_no` allocated atomically by `allocate_invoice_no()` (rewritten in ..04). OBSERVED [baseline:725](supabase/migrations/00000000000001_baseline_abc_schema.sql#L725)–[740](supabase/migrations/00000000000001_baseline_abc_schema.sql#L740). |
| **invoice_lines** | `id` uuid | `invoice_id` NOT NULL, `worker_id`, snapshot `worker_name`,`position`, `worked_hours`,`bill_rate_usd`,`amount_usd`; `kind` text DEFAULT `'hourly'` CHECK in (`hourly`,`session`), `sessions_count` int, `session_rate_usd` (added ..11) | Line items; carries both hourly and session lines. Snapshot columns denormalize worker name/position. OBSERVED [baseline:710](supabase/migrations/00000000000001_baseline_abc_schema.sql#L710)–[719](supabase/migrations/00000000000001_baseline_abc_schema.sql#L719), [per_session_billing:77](supabase/migrations/00000000000011_per_session_billing.sql#L77)–[84](supabase/migrations/00000000000011_per_session_billing.sql#L84). |

### Onboarding / e-sign / docs

| Table | PK | Key columns | Purpose / goal |
|---|---|---|---|
| **agreement_templates** | `kind` agreement_kind | `title`,`version` DEFAULT `'1.0'`, `body` text DEFAULT `''` | The 4 standard agreement bodies (seeded ..07). OBSERVED [baseline:571](supabase/migrations/00000000000001_baseline_abc_schema.sql#L571)–[578](supabase/migrations/00000000000001_baseline_abc_schema.sql#L578), [seed_agreement_templates:14](supabase/migrations/00000000000007_seed_agreement_templates.sql#L14). |
| **onboarding_agreements** | (`worker_id`,`agreement_kind`) | merge fields `f_rate`,`f_start_date`,`f_position`,`f_company_name`,`f_employment_type`,`f_schedule`,`f_hours_per_week`; countersign block (`countersigned_by`,`countersign_method`,`countersign_data`,`countersign_ip`,`countersigner_name`); `addendum_*` | Per-worker prepared agreement + admin countersignature. OBSERVED [baseline:759](supabase/migrations/00000000000001_baseline_abc_schema.sql#L759)–[782](supabase/migrations/00000000000001_baseline_abc_schema.sql#L782). |
| **onboarding_signatures** | `id` uuid; UNIQUE (`worker_id`,`agreement_kind`,`doc_version`) | `doc_sha256`, `signed_legal_name` NOT NULL, `signature_method` signature_method, `signature_data` text, `scrolled_to_end` bool, `ip_address` inet, `user_agent`, `device_fingerprint`, `status` signature_status | E-sign ledger (evidentiary). OBSERVED [baseline:821](supabase/migrations/00000000000001_baseline_abc_schema.sql#L821)–[838](supabase/migrations/00000000000001_baseline_abc_schema.sql#L838). |
| **onboarding_progress** | `worker_id` | `current_stage` onboarding_stage, `stage1/2/3_complete` bools, `name_mismatch_flag`,`stalled` bools, `completed_at`, `extra_documents` jsonb | Onboarding state machine; `is_onboarded()` keys off `completed_at`. OBSERVED [baseline:788](supabase/migrations/00000000000001_baseline_abc_schema.sql#L788)–[802](supabase/migrations/00000000000001_baseline_abc_schema.sql#L802). |
| **onboarding_reminders** | `id` uuid | `stage_at_send` onboarding_stage, `reminder_day` int, `channel` | Reminder send log. OBSERVED [baseline:808](supabase/migrations/00000000000001_baseline_abc_schema.sql#L808)–[815](supabase/migrations/00000000000001_baseline_abc_schema.sql#L815). |
| **documents** | `id` uuid | `worker_id` NOT NULL, `company_id`, `kind` document_kind, `storage_path` (nullable for waive/defer), `review_status` review_status, `review_reason`,`reviewed_by`,`reviewed_at`, `mime_type`,`file_size_bytes`,`side` | Uploaded onboarding docs + review workflow. Files live in `contractor-docs` bucket (..09). OBSERVED [baseline:673](supabase/migrations/00000000000001_baseline_abc_schema.sql#L673)–[691](supabase/migrations/00000000000001_baseline_abc_schema.sql#L691). |
| **portal_notifications** | `id` uuid | `worker_id` NOT NULL, `kind` portal_notification_kind, `title` NOT NULL, `dismissed_at` | Portal alert feed. OBSERVED [baseline:913](supabase/migrations/00000000000001_baseline_abc_schema.sql#L913)–[921](supabase/migrations/00000000000001_baseline_abc_schema.sql#L921). |

### Config / system

| Table | PK | Key columns | Purpose / goal |
|---|---|---|---|
| **portal_settings** | `id` int DEFAULT 1 CHECK `=1` (singleton) | `editable_fields` jsonb, `onboarding_config` jsonb (large default blob) | Global portal/onboarding config as a single JSONB row. OBSERVED [baseline:927](supabase/migrations/00000000000001_baseline_abc_schema.sql#L927)–[933](supabase/migrations/00000000000001_baseline_abc_schema.sql#L933). |
| **announcements** | `id` uuid | `title` NOT NULL, `body`, `author`, `active` bool | Portal/dashboard announcements. OBSERVED [baseline:584](supabase/migrations/00000000000001_baseline_abc_schema.sql#L584)–[591](supabase/migrations/00000000000001_baseline_abc_schema.sql#L591). |
| **audit_log** | `id` uuid | `company_id` (nullable), `actor`,`action` NOT NULL,`entity`,`detail` jsonb | Append-only audit trail (enforced by trigger ..05). OBSERVED [baseline:619](supabase/migrations/00000000000001_baseline_abc_schema.sql#L619)–[627](supabase/migrations/00000000000001_baseline_abc_schema.sql#L627). |
| **api_tokens** | `provider` text | `refresh_token` NOT NULL, `access_token`, `access_expires_at` | OAuth token store (Hubstaff). **SENSITIVE.** OBSERVED [baseline:597](supabase/migrations/00000000000001_baseline_abc_schema.sql#L597)–[603](supabase/migrations/00000000000001_baseline_abc_schema.sql#L603). |
| **app_secrets** | `key` text | `value` text NOT NULL | Server secret store: `tools_enc_key` (pgp_sym key) and `cron_secret`. **HIGHLY SENSITIVE.** OBSERVED [baseline:609](supabase/migrations/00000000000001_baseline_abc_schema.sql#L609)–[613](supabase/migrations/00000000000001_baseline_abc_schema.sql#L613); keys referenced [baseline:321](supabase/migrations/00000000000001_baseline_abc_schema.sql#L321),[528](supabase/migrations/00000000000001_baseline_abc_schema.sql#L528), [hubstaff_daily_ingest_cron:37](supabase/migrations/00000000000010_hubstaff_daily_ingest_cron.sql#L37). |
| **worker_tools** | `worker_id` | `requested` jsonb, `enc` text (pgp-armored creds, **one-time-reveal**, nulled on reveal), `popup_pending` bool, `provisioned_at`,`acked_at`,`revealed_at` | Encrypted 3rd-party tool credentials handed to a contractor once. **SENSITIVE.** OBSERVED [baseline:1015](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1015)–[1024](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1024), comments [1030](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1030). |
| **mood_checkins** | `id` uuid | `worker_id`, `mood` int, `note`, `kind` text | Contractor portal daily mood check-in. **NOT an orphan** — read by `fetchLatestMoodCheckin` and written by `insertMoodCheckin` (`src/db/queries/portal.ts`), via server action `saveMoodCheckin` (`src/server/actions/portal.ts`, guarded by `requireWorker`). OBSERVED schema [baseline:746](supabase/migrations/00000000000001_baseline_abc_schema.sql#L746)–[753](supabase/migrations/00000000000001_baseline_abc_schema.sql#L753); INFERRED usage from app code (Track-4 Explore pass).

**Orphan check:** No fully-orphan table found. `mood_checkins` is the candidate but is live (above). The closest to dead weight is **`onboarding_reminders`** — it has a table + worker index + RLS enabled but **zero RLS policies** and the column set is a pure send-log; whether it is written from app code was not confirmed in this track (ASSUMPTION: low-traffic / possibly write-only via service role). `app_secrets` query helper `getAppSecret()` exists but the Explore pass found it largely unreferenced from user-facing actions — INFERRED it is consumed by SQL functions (`reveal_worker_tools`, cron) rather than app code, which is by design.

---

## §2 Relationship / ER summary

### Foreign keys (all OBSERVED, baseline §FK block [1360](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1360)–[1516](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1516); service_sessions FK [per_session_billing:24](supabase/migrations/00000000000011_per_session_billing.sql#L24))

| Child.column | → Parent | ON DELETE | Line |
|---|---|---|---|
| admin_companies.company_id | companies.id | **CASCADE** | [1361](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1361) |
| admin_users.user_id | auth.users.id | **CASCADE** | [1371](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1371) |
| admin_users.added_by | auth.users.id | SET NULL | [1366](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1366) |
| audit_log.company_id | companies.id | SET NULL | [1376](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1376) |
| contractor_logins.auth_user_id | auth.users.id | SET NULL | [1381](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1381) |
| contractor_logins.worker_id | workers.id | **CASCADE** | [1386](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1386) |
| documents.company_id | companies.id | SET NULL | [1391](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1391) |
| documents.reviewed_by | auth.users.id | SET NULL | [1396](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1396) |
| documents.worker_id | workers.id | **CASCADE** | [1401](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1401) |
| hubstaff_projects.company_id | companies.id | **CASCADE** | [1406](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1406) |
| invoice_lines.invoice_id | invoices.id | **CASCADE** | [1411](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1411) |
| invoice_lines.worker_id | workers.id | SET NULL | [1416](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1416) |
| invoices.company_id | companies.id | **CASCADE** | [1421](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1421) |
| mood_checkins.worker_id | workers.id | **CASCADE** | [1426](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1426) |
| onboarding_agreements.worker_id | workers.id | **CASCADE** | [1431](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1431) |
| onboarding_progress.worker_id | workers.id | **CASCADE** | [1436](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1436) |
| onboarding_reminders.worker_id | workers.id | **CASCADE** | [1441](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1441) |
| onboarding_signatures.worker_id | workers.id | **CASCADE** | [1446](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1446) |
| pay_periods.company_id | companies.id | **CASCADE** | [1451](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1451) |
| payments.company_id | companies.id | **CASCADE** | [1456](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1456) |
| payments.pay_period_id | pay_periods.id | **CASCADE** | [1461](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1461) |
| payments.worker_id | workers.id | **CASCADE** | [1466](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1466) |
| pending_admins.added_by | auth.users.id | SET NULL | [1471](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1471) |
| portal_notifications.worker_id | workers.id | **CASCADE** | [1476](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1476) |
| rates.company_id | companies.id | **CASCADE** | [1481](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1481) |
| rates.worker_id | workers.id | **CASCADE** | [1486](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1486) |
| time_entries.company_id | companies.id | **CASCADE** | [1491](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1491) |
| time_entries.pay_period_id | pay_periods.id | SET NULL | [1496](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1496) |
| time_entries.worker_id | workers.id | SET NULL | [1501](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1501) |
| worker_companies.company_id | companies.id | **CASCADE** | [1506](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1506) |
| worker_companies.worker_id | workers.id | **CASCADE** | [1511](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1511) |
| worker_tools.worker_id | workers.id | **CASCADE** | [1516](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1516) |
| service_sessions.company_id | companies.id | **CASCADE** | [per_session_billing:24](supabase/migrations/00000000000011_per_session_billing.sql#L24) |
| service_sessions.worker_id | workers.id | SET NULL | [per_session_billing:24](supabase/migrations/00000000000011_per_session_billing.sql#L24) |

**Missing FKs (INFERRED, columns present but no constraint):**
- `admin_companies.admin_email` → `admin_users.email` — **no FK** (loose email coupling; an `admin_companies` row can reference an email with no `admin_users` row). OBSERVED absence: no constraint at [1360](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1360).
- `service_sessions.approved_by` / `created_by`, `time_entries.approved_by`, `payments.created_by`-style approver/actor uuids, `documents.reviewed_by` is FK'd but `onboarding_agreements.countersigned_by`/`prepared_by`/`countersigner_user_id` are **bare uuids, no FK**. OBSERVED [baseline:765](supabase/migrations/00000000000001_baseline_abc_schema.sql#L765)–[768](supabase/migrations/00000000000001_baseline_abc_schema.sql#L768).
- `worker_tools.worker_id` and `contractor_logins.worker_id` are FK'd, but there is **no FK from `workers` to `companies`** (correct — that's what `worker_companies` is for).

**Cascade hot-spot:** deleting a `companies` row cascades to `admin_companies`, `hubstaff_projects`, `invoices` (→`invoice_lines`), `pay_periods` (→`payments`, and detaches `time_entries`), `payments`, `rates`, `time_entries`, `worker_companies`, `service_sessions`. **A single `DELETE FROM companies` wipes a tenant's entire payroll + invoicing history.** Deleting a `workers` row cascades to nearly all worker-scoped tables (documents, onboarding_*, payments, rates, worker_companies, worker_tools, mood_checkins, portal_notifications, contractor_logins). This is intentional but high-blast-radius. RISK noted in §7.

### View
- **v_payouts_by_period** — `security_invoker='true'` (runs with caller's RLS, good), aggregates `payments ⋈ pay_periods ⋈ companies` to net/payout totals per company/period. OBSERVED [baseline:978](supabase/migrations/00000000000001_baseline_abc_schema.sql#L978)–[990](supabase/migrations/00000000000001_baseline_abc_schema.sql#L990). No other views.

### ER text diagram (by domain)

```
IDENTITY / TENANCY
  auth.users ──< admin_users ──(email, no FK)── admin_companies >── companies
  auth.users ──< contractor_logins >── workers
  pending_admins (staging → admin_users via trigger)
  workers ──< worker_companies >── companies      (assignment + bill/session rates)

PAYROLL
  companies ──< pay_periods ──< payments >── workers
  workers ──< rates >── companies
  (payments.pay_period_id, payments.worker_id ; UNIQUE(pay_period,worker))

TIME
  companies(employer) ──< time_entries >── workers   (time_entries.pay_period_id → pay_periods)
  companies ──< hubstaff_projects
  companies(client) ──< service_sessions >── workers (flat-fee path)

INVOICING
  companies(client) ──< invoices ──< invoice_lines >── workers
  (invoice_lines.kind ∈ hourly|session)

ONBOARDING / DOCS / E-SIGN
  workers ──< onboarding_progress (1:1)
  workers ──< onboarding_agreements >── agreement_templates(by kind)
  workers ──< onboarding_signatures
  workers ──< onboarding_reminders
  workers ──< documents >── companies (SET NULL)
  workers ──< portal_notifications
  workers ──< mood_checkins
  workers ──< worker_tools (1:1)

CONFIG / SYSTEM
  portal_settings (singleton id=1)   announcements   audit_log >── companies(SET NULL)
  api_tokens (by provider)   app_secrets (by key)

VIEW: v_payouts_by_period = payments ⋈ pay_periods ⋈ companies
```

---

## §3 Normalization & schema smells

- **JSONB doing relational work:**
  - `portal_settings.onboarding_config` — an entire onboarding spec (documents[], agreements[], profile_tabs, flags) encoded in one JSONB default blob; would normally be tables (`onboarding_required_documents`, `onboarding_required_agreements`). Single-row singleton (CHECK `id=1`). OBSERVED [baseline:931](supabase/migrations/00000000000001_baseline_abc_schema.sql#L931). Trade-off accepted (it's editable global config), but there is **no JSON Schema/CHECK** on its shape — a malformed write breaks the portal. SMELL.
  - `payments.misc_items` jsonb — holds the *real* subtracted deductions/additions (kind=deduction) that affect `net_php`; only constraint is `jsonb_typeof = 'array'` ([baseline:891](supabase/migrations/00000000000001_baseline_abc_schema.sql#L891)). The financially-material line items are unstructured JSON with no per-item amount/sign validation. SMELL (integrity risk for payroll math).
  - `workers.payout_account`, `workers.wise_recipients`, `workers.profile_extras`, `companies.contacts` — semi-structured JSONB ([baseline:1047](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1047),[1054](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1054),[1071](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1071),[643](supabase/migrations/00000000000001_baseline_abc_schema.sql#L643)). `contacts` shape only documented in a COMMENT ([baseline:652](supabase/migrations/00000000000001_baseline_abc_schema.sql#L652)).
- **Enum-as-text without CHECK / proper enum:**
  - `invoices.status` is **text** DEFAULT `'draft'` with **no CHECK** ([baseline:732](supabase/migrations/00000000000001_baseline_abc_schema.sql#L732)) — yet code relies on `status <> 'void'` (allocator [invoice_no_atomic:48](supabase/migrations/00000000000004_invoice_no_atomic.sql#L48), partial unique [baseline:1296](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1296)). A typo'd status silently bypasses the live-invoice uniqueness. SMELL.
  - `contractor_logins.status` text DEFAULT `'active'`, no CHECK ([baseline:664](supabase/migrations/00000000000001_baseline_abc_schema.sql#L664)) — `my_worker_id()` keys off `status='active'`.
  - `companies.kind` and `admin_users.role` / `pending_admins.role` *do* have CHECKs (good) ([baseline:645](supabase/migrations/00000000000001_baseline_abc_schema.sql#L645),[564](supabase/migrations/00000000000001_baseline_abc_schema.sql#L564),[906](supabase/migrations/00000000000001_baseline_abc_schema.sql#L906)).
  - `invoice_lines.kind` got a CHECK in ..11 ([per_session_billing:84](supabase/migrations/00000000000011_per_session_billing.sql#L84)) — but it's text, not an enum.
- **Denormalization (acceptable snapshots, flagged):** `invoice_lines.worker_name`/`position` snapshot the worker at invoice time ([baseline:714](supabase/migrations/00000000000001_baseline_abc_schema.sql#L714)–[715](supabase/migrations/00000000000001_baseline_abc_schema.sql#L715)); `payments.original_net_php` snapshots pre-edit net. Intentional for immutability.
- **Avatars legacy smell — FIXED.** The old design stored a base64 JPEG data-URI in `workers.photo_url`; ..02 moved photos to a private `avatars` storage bucket and `photo_url` now holds only an object path (enforced by COMMENT, not a CHECK). OBSERVED [storage_avatars_bucket:14](supabase/migrations/00000000000002_storage_avatars_bucket.sql#L14),[58](supabase/migrations/00000000000002_storage_avatars_bucket.sql#L58). Residual smell: nothing *prevents* a `data:` URI being written again (no CHECK constraint).
- **Nullable-that-should-be-NOT-NULL:**
  - `time_entries.worker_id` is nullable ([baseline:959](supabase/migrations/00000000000001_baseline_abc_schema.sql#L959)) — by design (unmatched Hubstaff names), but means time can exist with no worker.
  - `payments` numeric inputs `expected_hours`,`worked_hours`,`performance_ratio`,`rate_php` are nullable ([baseline:867](supabase/migrations/00000000000001_baseline_abc_schema.sql#L867)–[870](supabase/migrations/00000000000001_baseline_abc_schema.sql#L870)) while the *_php totals are NOT NULL DEFAULT 0 — a draft payment can have null worked_hours but a non-null net.
  - `documents.storage_path` nullable by design (waive/defer placeholders, ..08).
- **Duplicated tenancy concept:** identity is split across `admin_users`(by user_id), `admin_companies`(by email), `contractor_logins`(by worker_id/auth uid). The **email vs user_id** join in `is_company_admin()` ([baseline:387](supabase/migrations/00000000000001_baseline_abc_schema.sql#L387)) is a normalization smell — an admin's company scope is resolved by lower(email) string match, fragile to email changes.

---

## §4 Missing constraints & indexes

### Missing CHECK constraints (all OBSERVED absences)
- **Money ≥ 0:** none on `payments.gross_php/net_php/rate_php/…`, `rates.amount_php`, `invoices.subtotal_usd/total_usd`, `invoice_lines.amount_usd/bill_rate_usd/worked_hours`, `worker_companies.bill_rate_usd/session_rate_usd`. Negative money is insertable. (`service_sessions.units >= 0` is the *only* non-negativity CHECK in the money/quantity space — [per_session_billing:28](supabase/migrations/00000000000011_per_session_billing.sql#L28).)
- **Ratio bounds:** `payments.performance_ratio` numeric(6,4) has no `0 <= ratio` / sane-upper CHECK ([baseline:869](supabase/migrations/00000000000001_baseline_abc_schema.sql#L869)); `time_entries.activity_pct`/`invoices.markup_pct` unbounded.
- **Date ordering:** present on `pay_periods` ([baseline:855](supabase/migrations/00000000000001_baseline_abc_schema.sql#L855)) and `rates` ([baseline:949](supabase/migrations/00000000000001_baseline_abc_schema.sql#L949)) — **but NOT on `invoices`** (`period_end >= period_start` missing, [baseline:728](supabase/migrations/00000000000001_baseline_abc_schema.sql#L728)) nor on `documents` (`expires_on >= issued_on/signed_on`).
- **State enum on `invoices.status`** — missing (see §3).

### UNIQUE constraints — present (good) and the gaps
- Added by migrations: `invoices_invoice_no_unique` partial unique ([invoice_no_atomic:25](supabase/migrations/00000000000004_invoice_no_atomic.sql#L25)); `documents_fileless_slot_uniq` partial unique ([documents_fileless_slot_unique:9](supabase/migrations/00000000000008_documents_fileless_slot_unique.sql#L9)); `service_sessions_external_ref_uniq` ([per_session_billing:47](supabase/migrations/00000000000011_per_session_billing.sql#L47)).
- Baseline uniques: `payments (pay_period_id, worker_id)` ([baseline:1205](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1205)); `time_entries (company_id, source_name, work_date)` ([1235](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1235)); `worker_companies (worker_id, company_id)` ([1250](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1250)) and partial `(company_id, hubstaff_user_id)` ([1336](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1336)); `invoices_one_live_per_period` partial ([1296](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1296)); `onboarding_signatures (worker_id, agreement_kind, doc_version)` ([1190](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1190)); `companies.name` ([1125](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1125)); `admin_users.email` ([1090](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1090)); `contractor_logins.auth_user_id` ([1135](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1135)).
- **Gap:** `rates` has **no** unique/exclusion constraint preventing overlapping effective ranges for the same (worker, company) — two open rates (`effective_end IS NULL`) can coexist, making "current rate" ambiguous. Only a plain btree index exists ([baseline:1320](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1320)). INFERRED integrity risk for payroll calc.

### FK index coverage (OBSERVED indexes [1264](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1264)–[1344](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1344) + ..11)
Indexed FKs: documents.worker_id, hubstaff_projects.company_id, invoice_lines.invoice_id, payments.company_id, payments.pay_period_id, time_entries.{company_id+work_date, pay_period_id, worker_id}, worker_companies.company_id, rates.(worker,company,effective_start), service_sessions.{company+date, worker, import_batch}.

**FK index gaps (unindexed FK → seq-scan on parent delete / join):**
- `payments.worker_id` — **no index** (only company_id and pay_period_id indexed). The worker→payments join and `ON DELETE CASCADE` from workers will seq-scan. OBSERVED absence ([baseline:1308](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1308),[1312](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1312) are the only payments indexes).
- `invoice_lines.worker_id` — no index ([baseline:1288](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1288) indexes only invoice_id).
- `rates.company_id` standalone — covered by composite leading with worker_id, so a company-only filter isn't index-served.
- `worker_companies.worker_id` standalone — **no index** (only company_id ([baseline:1340](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1340)) and the composite unique). The `my_worker_id → worker_companies` portal join (very hot — `fetchWorkerClients`) and the workers-delete cascade are unindexed on worker_id. NOTE the composite UNIQUE `(worker_id, company_id)` *can* serve worker_id-leading lookups, so this is partially mitigated.
- `documents.company_id`, `audit_log.actor` — unindexed (audit_log indexed on (company_id, created_at) only, [baseline:1268](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1268)).
- Onboarding/portal `*_worker_id` are mostly indexed; `onboarding_agreements`/`onboarding_progress` use worker_id as PK so covered.

These will hurt the **period/worker** payroll joins and worker-deletion cascades specifically (`payments.worker_id`, `invoice_lines.worker_id`).

---

## §5 RLS & tenant-isolation posture (priority section)

### Helper functions the policies depend on (all `SECURITY DEFINER`, `search_path=public`)
- `is_admin()` — any row in `admin_users` for caller. **Company-blind.** [baseline:373](supabase/migrations/00000000000001_baseline_abc_schema.sql#L373).
- `is_owner()` — caller is `admin_users.role='owner'`. [baseline:408](supabase/migrations/00000000000001_baseline_abc_schema.sql#L408).
- `is_company_admin(cid)` — owner OR caller's email ∈ `admin_companies` for `cid`. [baseline:384](supabase/migrations/00000000000001_baseline_abc_schema.sql#L384).
- `my_admin_company_ids()` — array of caller's `admin_companies.company_id`. [baseline:417](supabase/migrations/00000000000001_baseline_abc_schema.sql#L417).
- `admin_can_see_worker(wid)` — owner OR caller is company-admin of any company the worker is linked to (via `worker_companies`). [baseline:227](supabase/migrations/00000000000001_baseline_abc_schema.sql#L227).
- `my_worker_id()` — caller's active `contractor_logins.worker_id`. [baseline:431](supabase/migrations/00000000000001_baseline_abc_schema.sql#L431).
- `is_onboarded()` — caller's `onboarding_progress.completed_at IS NOT NULL`. [baseline:393](supabase/migrations/00000000000001_baseline_abc_schema.sql#L393).

### Per-table RLS coverage

| Table | RLS on? | Policies (cmd · role) | Scoping basis | Leak risk |
|---|---|---|---|---|
| admin_companies | yes [1520](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1520) | `owner_all` (ALL·auth, owner only); `read_self` (SELECT·auth, own email) [1523](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1523),[1527](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1527) | owner / self | Low |
| admin_users | yes [1533](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1533) | `read` (SELECT·auth, `is_admin()`) [1536](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1536) | any admin reads ALL admins (incl. other companies' admins, emails). **No INSERT/UPDATE/DELETE policy** → writes only via service role (admin-manage actions). | Low-Med: admin can enumerate all admin emails/roles cross-tenant. |
| agreement_templates | yes [1540](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1540) | `admin_all` (ALL·auth, `is_admin()`); `read` (SELECT·auth, **`USING (true)`**) [1543](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1543),[1547](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1547) | global config | Low (templates are global). Any admin can edit. |
| announcements | yes [1551](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1551) | `admin_write` (ALL·auth, `is_admin()`); `read` (SELECT·auth, `active OR is_admin()`) [1554](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1554),[1558](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1558) | global | Low. Company-blind admin write. |
| **api_tokens** | yes [1562](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1562) | **NONE** | n/a | Implicit deny for authenticated; only service role reads. Acceptable BUT relies on absence-of-policy. |
| **app_secrets** | yes [1565](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1565) | **NONE** | n/a | Same — holds `tools_enc_key`/`cron_secret`. Implicit deny. |
| audit_log | yes [1568](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1568) | `admin_all` (**ALL**·auth, `is_company_admin(company_id)`) [1571](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1571) | per company_id | **Med**: `FOR ALL` lets a scoped admin UPDATE/DELETE their company rows at SQL level; mitigated only by append-only trigger ([audit_log_append_only:26](supabase/migrations/00000000000005_audit_log_append_only.sql#L26)). Rows with `company_id IS NULL` (FK SET NULL on company delete) become invisible to non-owner admins. |
| companies | yes [1575](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1575) | `admin_all` (ALL·auth, `is_company_admin(id)`) [1578](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1578) | per company | Low. Contractors cannot read companies directly (only via service-role joins). |
| contractor_logins | yes [1582](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1582) | `self` (SELECT·auth, own auth_user OR `admin_can_see_worker`) [1585](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1585) | self / worker-scoped admin | Low. No write policy → service role only. |
| documents | yes [1589](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1589) | `admin_all` (ALL·auth, `admin_can_see_worker OR is_company_admin(company_id)`); `contractor_insert` (INSERT·auth, own worker, kind≠other, pending); `contractor_read` (SELECT·auth, own worker, kind≠other) [1592](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1592),[1596](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1596),[1600](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1600) | worker / company | Low-Med: **no contractor UPDATE/DELETE** (good); contractor cannot see `kind='other'` docs. Admin scoping is worker-link based. |
| hubstaff_projects | yes [1604](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1604) | `admin_all` (ALL·auth, owner OR company ∈ my_admin_company_ids) [1607](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1607) | per company | Low |
| invoice_lines | yes [1611](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1611) | `admin_all` (ALL·auth, owner OR parent invoice's company ∈ scope) [1614](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1614) | via parent invoice | Low |
| invoices | yes [1622](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1622) | `admin_all` (ALL·auth, owner OR company ∈ scope) [1625](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1625) | per company | Low |
| mood_checkins | yes [1629](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1629) | `self_insert` (INSERT·auth, own worker); `self_read` (SELECT·auth, own OR `admin_can_see_worker`) [1632](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1632),[1636](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1636) | self / worker-scoped admin | Low |
| onboarding_agreements | yes [1640](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1640) | `admin_all` (ALL·auth, `admin_can_see_worker`); `read_own` (SELECT·auth, own worker) [1643](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1643),[1647](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1647) | worker | Low |
| onboarding_progress | yes [1651](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1651) | `admin_write` (ALL·auth, `admin_can_see_worker`); `read` (SELECT·auth, own OR admin) [1654](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1654),[1658](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1658) | worker | Low |
| **onboarding_reminders** | yes [1662](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1662) | **NONE** | n/a | Implicit deny for authenticated → service role only. (Likely intentional write-only log.) |
| onboarding_signatures | yes [1665](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1665) | `read` (SELECT·auth, own OR `admin_can_see_worker`) [1668](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1668) | worker | Low. No INSERT policy → signatures written via service role (good for evidentiary integrity). |
| pay_periods | yes [1672](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1672) | `admin_all` (ALL·auth, owner OR company ∈ scope); `contractor_read` (SELECT·auth, **`my_worker_id() IS NOT NULL AND is_onboarded()`**) [1675](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1675),[1679](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1679) | per company / **any onboarded contractor** | **Med**: the contractor read predicate is NOT worker- or company-scoped — **any onboarded contractor can read ALL pay_periods of ALL companies** (start/end/pay dates/state). Cross-tenant metadata leak. |
| payments | yes [1683](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1683) | `admin_all` (ALL·auth, owner OR company ∈ scope); `contractor_read` (SELECT·auth, own worker AND onboarded) [1686](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1686),[1690](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1690) | per company / own worker | Low. Contractor sees only own pay. |
| pending_admins | yes [1694](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1694) | `read` (SELECT·**no role clause**, `is_owner()`) [1697](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1697) | owner | Low. No write policy → service role. |
| portal_notifications | yes [1701](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1701) | `dismiss` (UPDATE·auth, own worker); `read` (SELECT·auth, own OR admin) [1704](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1704),[1708](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1708) | worker | Low. No contractor INSERT → service role creates. |
| portal_settings | yes [1712](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1712) | `admin_write` (ALL·auth, `is_admin()`); `read` (SELECT·auth, **`USING (true)`**) [1715](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1715),[1719](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1719) | global singleton | Low (global config; read by all auth, write by any admin). |
| rates | yes [1723](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1723) | `admin_all` (ALL·auth, `is_company_admin(company_id)`) [1726](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1726) | per company | Low. Contractors cannot read their own PHP rate via RLS (no contractor policy) — intentional. |
| time_entries | yes [1730](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1730) | `admin_all` (ALL·auth, owner OR company ∈ scope); `contractor_read` (SELECT·auth, own worker AND onboarded) [1733](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1733),[1737](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1737) | per company / own worker | Low |
| worker_companies | yes [1741](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1741) | `admin_all` (ALL·auth, `is_company_admin(company_id)`) [1744](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1744) | per company | Low. **No contractor read** → portal picker uses service role (`fetchWorkerClients`, scoped to worker in app). |
| **worker_tools** | yes [1748](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1748) | **NONE** | n/a | Implicit deny; all access via SECURITY DEFINER RPCs (`get_my_tools`, `reveal_worker_tools`, `set_worker_tools`, `my_tools_pending`). Correct design for encrypted creds. |
| workers | yes [1751](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1751) | `admin_delete`/`admin_insert`/`admin_select`/`admin_update` + `contractor_read` (own worker) [1754](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1754)–[1770](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1770) | worker-link / created_by / self | See §5b. |
| service_sessions *(..11/..12)* | yes [per_session_billing:60](supabase/migrations/00000000000011_per_session_billing.sql#L60) | `admin_all` (ALL·auth, owner OR company ∈ my_admin_company_ids); `contractor_insert` (own worker, pending, onboarded, linked active client); `contractor_read` (own worker, onboarded) [per_session_billing:62](supabase/migrations/00000000000011_per_session_billing.sql#L62), [session_ei_fields_portal:21](supabase/migrations/00000000000012_session_ei_fields_portal.sql#L21),[41](supabase/migrations/00000000000012_session_ei_fields_portal.sql#L41) | per client company / own worker | Low. Contractor insert is tightly scoped (own + active client link). |

**Storage RLS** (objects): `avatars` and `contractor-docs` buckets have per-folder/owner policies; `contractor-docs` correctly uses `admin_can_see_worker` (not blind `is_admin()`) so an admin can only touch documents of workers they can see. OBSERVED [storage_avatars_bucket:28](supabase/migrations/00000000000002_storage_avatars_bucket.sql#L28)+, [storage_contractor_docs_bucket:34](supabase/migrations/00000000000009_storage_contractor_docs_bucket.sql#L34)+. Both buckets are `public=false`.

### (a) Tables with RLS disabled
**None.** Every public table has `ENABLE ROW LEVEL SECURITY`. **No `FORCE ROW LEVEL SECURITY`** anywhere — irrelevant for the anon/authenticated roles but means the `postgres`/table-owner role is not subject to RLS. The risk is instead **broad GRANTs**: every table has `GRANT ALL … TO anon, authenticated, service_role` ([baseline:2160](supabase/migrations/00000000000001_baseline_abc_schema.sql#L2160)–[2266](supabase/migrations/00000000000001_baseline_abc_schema.sql#L2266)), so the only thing standing between the **anon** role and the data is RLS — and several tables have only `TO authenticated` policies. anon has no matching policy on most tables → implicit deny, but the GRANT ALL to `anon` is a wide blast radius if any policy is ever written with `USING (true)` and no role clause (e.g. `agreement_templates_read`, `portal_settings_read` are `TO authenticated`, so anon is still denied — verified).

### (b) Too-permissive / company-blind policies
- **`pay_periods_contractor_read`** ([baseline:1679](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1679)): predicate `my_worker_id() IS NOT NULL AND is_onboarded()` — **not** tied to the contractor's own company. Any onboarded contractor reads every company's pay-period schedule. Cross-tenant leak (metadata, not amounts). **FINDING.**
- **`is_admin()`-gated writes** (company-blind): `agreement_templates_admin_all`, `announcements_admin_write`, `portal_settings_admin_write`, `workers_admin_insert`. For the first three (global config) this is by design. For **`workers_admin_insert`** ([baseline:1758](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1758)) it means *any* admin (incl. a single-client admin) can INSERT a `workers` row; combined with `created_by = auth.uid()` they then get select/update on it via `workers_admin_select/update` ([baseline:1762](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1762),[1766](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1766)). Not strictly cross-tenant *read*, but it lets any admin create global worker records. Minor.
- **`admin_users_read`** ([baseline:1536](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1536)): any admin reads ALL admins across all companies (emails, roles). Information disclosure.
- **`USING (true)`** appears on `agreement_templates_read` and `portal_settings_read` ([baseline:1547](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1547),[1719](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1719)) — both `TO authenticated` global config, acceptable.

### (c) companies vs accounts isolation — the crux
- **Admin A (company X) reading company Y's payments/workers?** Company-scoped tables (payments, invoices, time_entries, pay_periods, worker_companies, rates, companies, hubstaff_projects, service_sessions) all gate on `is_owner() OR company_id ∈ my_admin_company_ids()` (or `is_company_admin`). A non-owner admin scoped to X **cannot** read Y's payments/invoices/time/rates. ISOLATION HOLDS for financial data. **Caveats:** (1) `workers` is **not** company-scoped — a worker is visible to an admin if `admin_can_see_worker` (any shared company link) OR `created_by = auth.uid()`; a worker linked to multiple companies is visible to admins of *any* of those companies (by design). (2) `admin_users` is fully cross-tenant readable (b). (3) `pay_periods` leaks across tenants to contractors (b).
- **Contractor reading another contractor's data?** Worker-scoped tables key on `worker_id = my_worker_id()`: payments, time_entries, documents, onboarding_*, mood_checkins, portal_notifications, workers (self), service_sessions, worker_tools (via RPC). A contractor **cannot** read another contractor's pay/time/docs/tools. ISOLATION HOLDS. The single exception is `pay_periods` (company-level metadata, not per-worker) — leaked to all onboarded contractors.
- **Identity resolution is `SECURITY DEFINER`**: all gating functions run as `postgres` with fixed `search_path=public`, so they aren't subvertible by a caller's search_path. Good. `is_company_admin` resolves scope by **lower(email) string match** against `admin_users` — robust to UUID but fragile if an admin's email changes without updating `admin_companies` (they silently lose scope). INFERRED operational risk, not a leak.

### (d) Service-role client bypasses RLS — does app re-check authz?
- `src/db/clients/service.ts` `createServiceClient()` bypasses RLS; `server-only` import guard prevents client-bundle leakage. OBSERVED.
- Track-4 code pass (Explore) found that every audited service-client call path is preceded by an explicit guard — `requireAdmin()` / `requireOwner()` / `requireWorker()` / `getCurrentAdmin()` (defined in `src/server/auth/admin.ts`, `src/server/auth/worker.ts`) — **and** company-scoped actions additionally check `admin.isOwner || admin.companyIds.includes(companyId)` before using a client-supplied `company_id` (e.g. `contractors.ts`, `payroll.ts`, `invoicing.ts`, `hubstaff-sync.ts`). Contractor portal session insert verifies the target client is in the worker's active links (`portal-sessions.ts` → `fetchWorkerClients`). INFERRED: re-authorization is consistently applied; no unguarded service-role write to tenant data was found in the audited set. **Caveat (ASSUMPTION):** this is the app code present today; the security guarantee is *procedural* (in TypeScript), not enforced by the DB once RLS is bypassed — any future server action that forgets the guard would have unrestricted cross-tenant access. The DB cannot defend against that, which is why the over-permissive GRANT ALL + service key concentration matters.

---

## §6 PHI / sensitive-data handling

This app handles **PHI-adjacent** data (it ships a BAA template and references the PH Data Privacy Act — [seed_agreement_templates:74](supabase/migrations/00000000000007_seed_agreement_templates.sql#L74),[92](supabase/migrations/00000000000007_seed_agreement_templates.sql#L92)). Sensitive columns:

| Data class | Location | Notes |
|---|---|---|
| Names / DOB | `workers.first_name/middle_name/last_name/date_of_birth` | PII. `match_key` is a derived lowercased name (generated column [baseline:1039](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1039)). |
| Contact / address | `workers.email/mobile/ph_address/permanent_address/postal_code/address_landmark`, `companies.address/phone`, emergency contact (`emergency_name/relationship/mobile`) | PII [baseline:1041](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1041)–[1066](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1066). |
| Government / clearance docs | `documents.kind ∈ gov_id, nbi_clearance, w8ben, diploma` (document_kind enum [baseline:101](supabase/migrations/00000000000001_baseline_abc_schema.sql#L101)); files in private `contractor-docs` bucket | NBI clearance = PH police clearance (sensitive). Bucket is `public=false`, signed-URL access only ([storage_contractor_docs_bucket:9](supabase/migrations/00000000000009_storage_contractor_docs_bucket.sql#L9)). |
| Banking / payout | `workers.payout_account` jsonb, `wise_recipients` jsonb, `wise_recipient_id/uuid/tag`, `gcash/paymaya/paypal` | Financial PII in JSONB, **plaintext** ([baseline:1047](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1047)–[1059](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1059)). No app-level encryption; relies on Postgres at-rest encryption (Supabase-managed). RLS limits read to scoped admins + service role; **contractor cannot read own payout via RLS** (no contractor workers-column filtering — they read the whole `workers` row via `workers_contractor_read` self policy [1770](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1770), so a contractor *can* read their own banking JSON — expected for self-service). |
| Signature evidence | `onboarding_signatures.signature_data` (drawn-signature blob), `ip_address` inet, `user_agent`, `device_fingerprint`; `onboarding_agreements.countersign_data/countersign_ip` | Biometric-ish + network identifiers. Plaintext. Read gated to self/scoped-admin ([baseline:1668](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1668)). |
| **Recoverable credentials** | `worker_tools.enc` | **Encrypted** with `pgp_sym_encrypt` using key from `app_secrets.tools_enc_key`; **one-time reveal** then `enc` nulled ([baseline:323](supabase/migrations/00000000000001_baseline_abc_schema.sql#L323),[346](supabase/migrations/00000000000001_baseline_abc_schema.sql#L346),[1030](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1030)). Good design. **Caveat:** the decryption key sits in `app_secrets` in the *same database* — anyone with service-role/DB access can decrypt. Encryption protects against table-level leakage, not against service-key compromise. |
| Secrets | `app_secrets.value` (`tools_enc_key`, `cron_secret`), `api_tokens.refresh_token/access_token` (Hubstaff OAuth) | Server-only (RLS = no policy → service role only). **The Hubstaff anon JWT and the project ref are hard-coded in [hubstaff_daily_ingest_cron:36](supabase/migrations/00000000000010_hubstaff_daily_ingest_cron.sql#L36)** (anon key is public by nature, so low severity, but it's a committed long-lived token; `x-cron-secret` is correctly read from `app_secrets`, not hard-coded). |

**Encryption-at-rest assumption (ASSUMPTION):** banking and signature data rely on Supabase platform disk encryption; no column-level crypto except `worker_tools.enc`. For a HIPAA/BAA posture this is the weakest point — payout JSON and signature blobs are queryable plaintext to anyone with DB/service access.

---

## §7 Highest-risk findings (ranked)

**Security / isolation**
1. **`pay_periods_contractor_read` is not tenant-scoped** — any onboarded contractor reads every company's pay-period schedule (cross-tenant metadata leak). Fix: scope to companies the worker is linked to. [baseline:1679](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1679).
2. **`audit_log` RLS is `FOR ALL`** — a scoped admin can mutate/delete their company's audit trail at the SQL level; only a trigger (..05) prevents it, and a trigger is droppable by superuser/migration. RLS should be SELECT+INSERT only. [baseline:1571](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1571).
3. **`admin_users_read` exposes all admins cross-tenant** (emails, roles, names) to any admin. Information disclosure. [baseline:1536](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1536).
4. **Procedural-only authz once service-role is used + `GRANT ALL TO anon/authenticated` on every table** — the DB's last line of defense is RLS; a single forgotten guard in a future server action grants unrestricted cross-tenant access, and the encryption key for `worker_tools` lives in-DB. Concentration risk on `SUPABASE_SERVICE_KEY`. [baseline:2160](supabase/migrations/00000000000001_baseline_abc_schema.sql#L2160)+; [service.ts](src/db/clients/service.ts).
5. **Plaintext financial/biometric PII** (`workers.payout_account`/`wise_recipients`, `onboarding_signatures.signature_data`) with only platform at-rest encryption. §6.

**Integrity**
6. **No money/ratio CHECK constraints** on payments/rates/invoices/invoice_lines — negative or absurd amounts insertable; `performance_ratio` unbounded. §4.
7. **`payments.misc_items` is unvalidated JSONB** yet financially material (real deductions affecting net). Only `jsonb_typeof=array` enforced. [baseline:891](supabase/migrations/00000000000001_baseline_abc_schema.sql#L891).
8. **`invoices.status` is unconstrained text** while the live-invoice uniqueness and allocator depend on `status <> 'void'`; a typo bypasses both. [baseline:732](supabase/migrations/00000000000001_baseline_abc_schema.sql#L732).
9. **No overlap guard on `rates`** effective ranges → ambiguous "current rate" for payroll. §4.
10. **`companies` delete cascades the whole tenant** (invoices/payments/periods/time/sessions); `workers` delete cascades nearly everything worker-scoped. High blast radius; rely on app never hard-deleting. §2.

**Performance / hygiene**
11. **Unindexed FKs on the hot payroll path**: `payments.worker_id`, `invoice_lines.worker_id`, `worker_companies.worker_id` (partially covered by composite unique). Hurts period/worker joins and worker-delete cascades. §4.
12. **Duplicate untracked migration** `00000000000013_…session 2.sql` (byte-identical to ..13, `git status ??`). Delete it. Idempotent so harmless if applied, but pollutes the ordered set.
13. **Hard-coded project ref + anon JWT** in the cron migration [hubstaff_daily_ingest_cron:33](supabase/migrations/00000000000010_hubstaff_daily_ingest_cron.sql#L33)–[36](supabase/migrations/00000000000010_hubstaff_daily_ingest_cron.sql#L36) — must be edited per environment; low severity (anon key is public) but a portability/secrets-hygiene smell.

---

## §8 Coverage note

Resolvable from migrations alone: all schema, FKs, indexes, CHECKs, RLS policies, functions, triggers, views, storage buckets — fully covered above.

**Not resolvable from migrations alone (would need a live DB or deeper code trace):**
- Whether `onboarding_reminders` and `app_secrets.getAppSecret()` are written/read by any runtime path (no RLS policy / sparse app references; INFERRED service-role-only). Live `pg_stat_user_tables` would confirm dead/live.
- Whether the live cloud project's RLS exactly matches these migrations (this is the LOCAL `config.toml` project at 127.0.0.1; the comment in ..03 admits the **baseline was edited in-place** so prod and a fresh local DB diverge on `deduction_php`/`shortfall_php` — schema drift is acknowledged in-source). [rename_deduction_to_shortfall:12](supabase/migrations/00000000000003_rename_deduction_to_shortfall.sql#L12).
- Supabase **advisor** results (`get_advisors` for unindexed FKs / RLS lints / SECURITY DEFINER search_path) — I did not call any Supabase MCP tool (read-only mandate); the unindexed-FK and `FOR ALL` findings above are the manual equivalent.
- Realtime publication membership (`supabase_realtime`) — only its owner is set ([baseline:1776](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1776)); which tables are published is not in the migration.
- The service-client authz re-check conclusion in §5d reflects the **current** app source; it is a procedural guarantee, not a DB-enforced one.
