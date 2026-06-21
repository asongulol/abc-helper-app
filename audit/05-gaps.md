# Track 5 — Gap Analysis (`abc-helper-app`)

Read-only audit. Every claim cites `file:line` / `table.column` / route. **OBSERVED** =
read in code; **INFERRED** = reasoned from evidence; **ASSUMPTION** = ambiguity flagged.
Verdicts re-verified against current code, not the doc checkboxes.

Scope anchor: stated goals from `README.md`, `docs/money-core-spec.md`,
`docs/RECREATION-RECOMMENDATIONS.md`, `docs/RECREATION-HANDOFF.md`.

---

## §1 Goal → capability matrix

| # | Goal | Supported? | Evidence | Gap |
|---|------|-----------|----------|-----|
| 1 | Time → payroll → payout pipeline, integer-centavos money core | **yes** | Pure engine `src/lib/pay/calc.ts:100-163`; centavos throughout; mappers `src/lib/payroll/mappers.ts`; orchestration `src/server/payroll.ts`; Wise draft-only `src/server/actions/wise.ts:71-144` | — (core is solid) |
| 2 | Wise draft-only payouts (never fund) + reconciliation | **yes** | Draft/batch `src/server/actions/wise.ts:71-144`; poll/match `wise.ts:155-230`; backfill preserves `original_net_php` `src/db/queries/wise.ts:125-229`; cron twin `supabase/functions/wise-payouts/index.ts` | "Check emails" recon path is a permanently-disabled stub `src/components/config/WiseReconCard.tsx:97-105` (nice-to-have); **no cron schedule migration for `wise-payouts`** (see §2.6) |
| 3 | Employer/client model; clients = billing tags w/ `bill_rate_usd` → client invoicing | **partial** | Employer derived from `companies.kind='employer'`; invoicing compute `src/lib/invoicing/compute.ts:111-192`; actions `src/server/actions/invoicing.ts`; status `draft→sent→paid→void` `src/types/schemas/invoicing.ts:24` | **Hubstaff import NOT wired into invoicing** (§2.1); **no invoice payment tracking** — `invoices.pay_date` written-never-read, no amount-received/payment-date (§4) |
| 4 | Contractor onboarding + immutable e-sign ledger; document review w/ expiry | **partial** | E-sign ledger `onboarding_signatures` (sha256/IP/UA); review approve/needs-replacement/waive/defer `src/server/actions/portal.ts:747-813`; expiry `documents.expires_on` + `runExpiryCheckNow` `src/server/actions/documents.ts:36` | **Expiry check is admin on-demand only — no scheduled send** (`runExpiryCheckNow` has no cron caller); **automated onboarding reminders absent** — `onboarding_reminders` table is dead (§2.2) |
| 5 | Time approval (Hubstaff sync + CSV import + manual override) | **yes** | Hubstaff sync `src/server/hubstaff/service.ts:197`; CSV import `src/server/actions/time.ts:260-345`; manual "Edit Total" override `src/components/time/TimeApprovalTable.tsx`; bulk approve-all `TimeApprovalTable.tsx:178` | — |
| 6 | Contractor portal: statements, time, docs, profile, onboarding, sessions | **yes** | Routes `src/app/portal/(authed)/{statements,time,docs,profile,onboarding,sessions}/page.tsx`; EI session submit migration `00000000000012` | — |
| 7 | Per-session (PS) / per-hour (PH) contract handling end-to-end | **partial** | Engine `src/lib/pay/calc.ts:104-127`; sessions fed to payroll `src/server/payroll.ts:69-86`; mappers PS pull-in `src/lib/payroll/mappers.ts:194-200`; admin approve sessions per-row `src/components/sessions/SessionsClient.tsx:105-114` | **No session CSV import** despite `service_sessions.external_ref` idempotency hook (migration `00000000000011:45-48`); **no bulk session approve** (§2.5, §3) |
| 8 | Multi-tenant RLS; secrets server-side; audit log | **yes** | RLS policies throughout baseline; secrets in `app_secrets` server-side; append-only audit `00000000000005`; audit UI w/ pagination+filter `src/components/audit/AuditTable.tsx:137-152` | — |
| 9 | Coverage-gap detection on overview | **no** | Overview computes payroll-readiness only `src/app/(admin)/overview/page.tsx`; `src/db/queries/overview.ts` | No coverage/scheduling-target model exists (§2.3, §4) |
| 10 | Admin re-scoping of existing admins | **no** | `addAdmin`/`removeAdmin`/`setAdminRole` only `src/server/actions/admin-manage.ts`; scope column read-only `src/components/config/AdminsCard.tsx:134-146` | No `setAdminCompanies` — must delete+re-add (§2.4) |
| 11 | Reports / export coverage | **partial** | 3 contractor CSV exports `src/components/reports/ReportsClient.tsx:484-865` | No payroll-register / payout-file / invoice-list / time exports (§2.7) |
| 12 | Mood check-ins | **partial (dead read)** | Write path real `src/server/actions/portal.ts` → `insertMoodCheckin` `src/db/queries/portal.ts:264` | `fetchLatestMoodCheckin` defined `portal.ts:139-150` but never called; data never displayed (§2.8) |

---

## §2 Detailed feature findings (Dimension A)

### 2.1 — Hubstaff import NOT wired into invoicing — **BLOCKS Goal 3 (client invoicing accuracy)**
**OBSERVED.** Invoicing reads hours from `time_entries` generically via
`fetchEmployerTrackedSeconds` (`src/db/queries/invoicing.ts`, consumed in
`src/server/actions/invoicing.ts`), and sessions from `service_sessions`. There is **no
explicit Hubstaff→invoice affordance**: no button in `src/app/(admin)/invoicing/page.tsx`
or `src/components/invoicing/InvoicingClient.tsx` to pull fresh Hubstaff time before
invoicing. Hubstaff data only reaches invoicing *implicitly* because the nightly cron
(`00000000000010_hubstaff_daily_ingest_cron.sql:28-49`) writes `time_entries` and invoicing
reads that table. `docs/RECREATION-RECOMMENDATIONS.md:105` ("Hubstaff import deferred") and
`:131` are **still accurate** — this remains deferred.
**Blocks?** Partially. Hourly invoices *can* compute from whatever is in `time_entries`, but
there is no on-demand "refresh hours for this billing window from Hubstaff" step, so an
invoice generated before the nightly sync (or for a window the cron's 3-day lookback missed)
silently under-bills. For a billing-accuracy goal this is a **blocking correctness gap**, not
cosmetic.

### 2.2 — Automated onboarding reminders ABSENT (table is dead) — **BLOCKS Goal 4**
**OBSERVED.** Settings exist: `onboarding_config.reminders` (in `portal_settings` JSONB,
edited via `src/components/config/OnboardingConfigCard.tsx`). The send-ledger table
`onboarding_reminders` exists (`00000000000001:808-818`). But **nothing ever inserts into it**
— the only references are the schema, generated types (`src/db/types.ts:714`), and migration
DDL; **zero code inserts** (grep across `src/` returns only `db/types.ts`). There is **no
cron / edge function** that reads the reminder cadence and sends mail: only two edge functions
exist (`supabase/functions/{hubstaff-sync,wise-payouts}`), neither about reminders.
nodemailer transport exists (`src/server/actions/portal-admin.ts:87 sendEmail`) and is used
for hire/credential emails, but never for a scheduled onboarding nudge.
**Conclusion:** configuration-without-execution. Contractors who stall in onboarding are
never automatically reminded. Stated goal 4 ("expiry tracking", onboarding flow) implies
reminders; they are **absent**.

Related: **document-expiry reminders are also send-less.** `runExpiryCheckNow`
(`src/server/actions/documents.ts:36`) only *returns* overdue/expiring lists to an admin who
clicks; no scheduled caller exists. Expiry tracking is therefore *display-on-demand*, not
*proactive notification*.

### 2.3 — Coverage-gap detection ABSENT — **BLOCKS Goal (coverage-gap on overview)**
**OBSERVED.** `src/app/(admin)/overview/page.tsx` + `src/db/queries/overview.ts` compute
*payroll-readiness* attention signals only: time pending approval, contractors missing a rate
(`no_rate`) or payout method (`no_payout_method`), locked-not-sent periods, pending doc reviews
/ incomplete onboarding. **Absent:** contractors with zero tracked time for a period they were
expected to work; unattributed time surfaced on the overview; sessions expected-but-missing;
any comparison against a scheduling/coverage target. **INFERRED:** there is no schema for
expected coverage at all (§4), so the overview cannot flag a "gap" — it can only flag missing
config. This is a genuine missing capability, not just a missing widget.

### 2.4 — Admin re-scoping ABSENT — **nice-to-have (operational friction)**
**OBSERVED.** `src/server/actions/admin-manage.ts` exposes `addAdmin` (sets
`admin_companies` at add-time only), `removeAdmin` (deletes all scope rows), `setAdminRole`
(role only, never scope). No `setAdminCompanies`/re-scope action. `AdminsCard.tsx:134-146`
renders scope as a read-only column with no edit control. To change an existing admin's
companies you must remove and re-add. Not blocking (workaround exists) but a real gap for a
multi-tenant admin model.

### 2.5 — Session CSV import ABSENT; no bulk session approve — **nice-to-have / partial Goal 7**
**OBSERVED.** `service_sessions.external_ref` + a partial unique index exist specifically for
"idempotent CSV imports" (`00000000000011_per_session_billing.sql:45-48`), but **no UI or
server action imports sessions by CSV.** Sessions enter only via the admin add-form
(`SessionsClient.tsx:189-266`) or contractor portal (`PortalSessions.tsx`, constrained to EI
items). Admin approves sessions **one row at a time** (`SessionsClient.tsx:105-114`); there is
no "approve all pending" for sessions (contrast time, which has one at
`TimeApprovalTable.tsx:178`). For an EI/per-session provider with many visits this is real
throughput friction.

### 2.6 — Wise reconciliation: complete except a disabled stub + missing cron schedule
**OBSERVED.** End-to-end recon is real: `wisePoll` / `wiseMatch`
(`src/server/actions/wise.ts:155-230`), backfill preserves `original_net_php`
(`src/db/queries/wise.ts:125-229`), card buttons "Backfill all paid periods" / "Scan all"
(`WiseReconCard.tsx:78,128`). **Stub:** "Check emails" button is hardcoded `disabled` with
title "No email-check action is wired yet (legacy parity TODO)"
(`WiseReconCard.tsx:97-105`) — matches the handoff caveat (`RECREATION-HANDOFF.md:121-122`).
**Gap:** the `wise-payouts` edge function is the documented "scheduled twin" of `servicePoll`,
but **no migration schedules it** (`cron.schedule` appears only for hubstaff in
`00000000000010`). So scheduled Wise reconciliation depends on an out-of-band cron not
captured as a migration — a deploy-reproducibility gap (cf. R1 #7 "no out-of-band DDL").
**ASSUMPTION:** it may be scheduled manually in the Supabase dashboard; not verifiable from the
repo.

### 2.7 — Reports/export coverage PARTIAL — **nice-to-have**
**OBSERVED.** Three contractor-scoped CSV exports exist
(`src/components/reports/ReportsClient.tsx:484-513, 516-558, 833-865`). **Absent:** a
payroll-register export (all contractors × all periods in one sheet), a payout/remittance file
export, an invoice-list export, and a raw time/hours export. None block a stated goal but all
are expected of a payroll system.

### 2.8 — Mood check-ins: write-only, read path dead — **nice-to-have**
**OBSERVED.** `saveMoodCheckin` → `insertMoodCheckin` (`src/db/queries/portal.ts:264`) is a
real write path (contradicts the "no-op fake" the earlier doc described — that part is now
fixed). But `fetchLatestMoodCheckin` (`portal.ts:139-150`) is **never imported/called**, and
no admin or portal screen displays mood. Data is written and never read — effectively dead.
Acknowledged as an approved deviation (`RECREATION-HANDOFF.md:126`); flagging that it remains
half-built.

### 2.9 — PH/PS payroll IS end-to-end in the engine — **verified present (not a gap)**
**OBSERVED.** PH (per hour) and PS (per session) are handled in the pure engine
(`src/lib/pay/calc.ts:104-127`: `perUnit` branch — gross = rate × units, no expected/ratio,
13th-month skipped), expected-hours returns 0 day-hours for PH/PS
(`src/lib/pay/expected-hours.ts:23-24`), and the orchestration fetches session units and feeds
them (`src/server/payroll.ts:69-86`; `src/lib/payroll/mappers.ts:160-200`). Schema/enum support
present (`00000000000013`, `src/types/schemas/contractors.ts:16`). This is the *one* place the
doc's "done" claim holds up under re-verification.

---

## §2.10 — Duplicate migration file (operational hazard, found incidentally)
**OBSERVED.** `supabase/migrations/00000000000013_contract_type_per_hour_session 2.sql` is
**byte-identical** to `00000000000013_contract_type_per_hour_session.sql` (verified via diff).
Two migration files share the prefix `00000000000013`. On `supabase db reset` this is at best a
duplicate-version error and at worst re-runs `alter type ... add value` (idempotent via
`IF NOT EXISTS`, so harmless if it runs, but the *ordering/version collision* can abort the
migration run). This is an untracked stray file (it appears as `??` in `git status`) — it
should be deleted before any cutover dry-run.

---

## §2 BLOCKING gaps — ranked

A "blocking" gap prevents a stated goal from being achievable as intended.

1. **Onboarding reminders never send** (§2.2). `onboarding_reminders` is a dead table; no
   cron/edge fn reads the configured cadence. Goal 4's onboarding/expiry-tracking intent is
   not met — stalled contractors are silently never nudged. *Cheapest high-value fix.*
2. **Document-expiry checks are on-demand-only** (§2.2 tail). No scheduled expiry sweep;
   credentials (NBI 6-month freshness etc.) can lapse unnoticed until an admin manually clicks.
   Same root cause as #1 (no reminder/expiry scheduler).
3. **Hubstaff not wired into invoicing** (§2.1). Invoices bill from whatever happens to be in
   `time_entries`; no on-demand refresh for the billing window → under-billing risk. Blocks the
   *accuracy* of Goal 3 client invoicing.
4. **Coverage-gap detection absent** (§2.3) — and unbuildable without a coverage/scheduling
   data model (§4). The overview cannot flag "expected work didn't happen."
5. **No invoice payment tracking** (§4). Status `paid` is a bare flag; no amount-received /
   payment-date / partial-payment. AR cannot be reconciled. Blocks the billing side of Goal 3.
6. **`wise-payouts` cron not captured as a migration** (§2.6). Scheduled reconciliation relies
   on out-of-band config — violates the repo's own "no out-of-band DDL" rule and is a cutover
   reproducibility risk.

Everything else (admin re-scoping, session CSV/bulk-approve, report exports, mood read path,
"Check emails" button, missing `loading.tsx` files, pagination) is **non-blocking** (§5).

---

## §3 Missing UI affordances / states (Dimension B)

Primitives exist and are broadly used: `EmptyState`, `Toast` (69 `useToast` sites),
`ConfirmDangerModal`, `Spinner`, `SortableTable`. The **audit screen is the gold standard**
(pagination `src/app/(admin)/audit/page.tsx:10` PAGE_SIZE=50 + filter + empty state). Gaps:

| Screen | Missing state/affordance | Evidence | Blocks goal? |
|--------|--------------------------|----------|--------------|
| Admin: time approval | No pagination/virtualization — renders every entry per period | `src/components/time/TimeApprovalTable.tsx` (`.map` over all rows, no `.range`/limit) | Nice-to-have (scalability) |
| Admin: payroll | No pagination on draft rows — full `.map` of editable rows | `src/components/payroll/PayrollShell.tsx` | Nice-to-have (scalability) |
| Admin: documents | No search/filter; no pagination | `src/components/documents/DocumentsClient.tsx` (single table `.map`) | Nice-to-have |
| Admin: sessions | No search/filter; **no bulk approve**; weak empty text (not `EmptyState`) | `src/components/sessions/SessionsClient.tsx:268-277,295` | Nice-to-have (throughput, §2.5) |
| Admin: imports | No pagination on batch list; raw `.empty` div not `EmptyState` | `src/components/imports/DeleteImportsClient.tsx:352-368` | Nice-to-have |
| Admin: invoicing | **No `loading.tsx`**; only Toast/transition states, no skeleton/error page | `src/app/(admin)/invoicing/` (no `loading.tsx`); `InvoicingClient.tsx` | Nice-to-have |
| Admin: batches | No `loading.tsx` (page-level skeleton) | `src/app/(admin)/batches/` (no `loading.tsx`) | Nice-to-have |
| Admin: calculate | No `loading.tsx` | `src/app/(admin)/calculate/` (no `loading.tsx`) | Nice-to-have |
| Admin: sessions | No `loading.tsx` | `src/app/(admin)/sessions/` (no `loading.tsx`) | Nice-to-have |
| Admin: process | No explicit empty state if no ready/draft batches | `src/app/(admin)/process/page.tsx` → ProcessShell (INFERRED) | Nice-to-have |
| Admin: AdminsCard | Scope shown read-only, no edit affordance (no re-scope) | `src/components/config/AdminsCard.tsx:134-146` | Reflects §2.4 capability gap |
| Admin: WiseReconCard | "Check emails" permanently disabled, no explanation beyond title attr | `src/components/config/WiseReconCard.tsx:97-105` | Nice-to-have (stub) |
| Portal: docs/profile/time/statements/sessions | No `loading.tsx` for any portal route (server fetches, blank until hydrate) | `src/app/portal/(authed)/{docs,profile,time,statements,sessions}/` | Nice-to-have |
| Portal: sessions | No explicit empty state on history list (INFERRED) | `src/components/portal/PortalSessions.tsx` | Nice-to-have |

Strengths confirmed (not gaps): contractors screen (search + `EmptyState` +
`SortableTable`, `ContractorsClient.tsx:273-289`); pervasive Toast feedback; `ConfirmDangerModal`
for destructive ops; `disabled={isPending}` + working-text on mutations; portal statements/time
have empty states (`PortalStatements.tsx:17-19`, `PortalTime.tsx:42-44`).

**Net UI verdict:** no UI gap *blocks* a goal. The systemic pattern is (a) several routes lack
`loading.tsx` skeletons, and (b) large tables (time, payroll, documents, sessions, imports)
render all rows with no pagination — a scalability cliff, not a correctness blocker.

---

## §4 Data-model gaps (Dimension C)

Cross-checking goals against the schema (`00000000000001` baseline + migrations 0002–0013):

1. **No coverage / scheduling / expected-coverage model.** (Blocks §2.3 / Goal 9.) There is no
   table or column expressing "contractor X is expected to work this schedule / N sessions per
   period." `worker_companies.weekly_hours` (`00000000000001:1008`) exists but is informational
   and not compared to actuals anywhere. Without a target, "coverage gap" is uncomputable.
   *Missing:* a `coverage_targets` / scheduling structure.

2. **No invoice payment tracking.** (Blocks §2.1/§2.5 / Goal 3 billing side.) `invoices`
   (`00000000000001:725-740`) has `status` (`draft/sent/paid/void`) and `pay_date`, but `pay_date`
   is never read or written in code, and there is **no** `amount_received`, `paid_at`,
   `payment_method`, or partial-payment line. A "paid" invoice carries no record of how much/when
   was actually received. *Missing columns:* `invoices.amount_received_usd`, `paid_on`,
   `payment_ref`.

3. **No FX-rate history.** (Goal 1/2 — minor.) FX is stored only as a per-payment snapshot
   `payments.fx_rate` (`00000000000001:876`); there is no `fx_history` table tracking the
   open.er-api daily rate over time. Per-payment snapshot is sufficient for parity but precludes
   trend/audit of FX. *Missing:* an FX-rate-history table (nice-to-have).

4. **No reminder-cadence execution state.** (Blocks §2.2 / Goal 4.) `onboarding_reminders`
   exists as a *ledger* but the cadence config lives in JSONB (`portal_settings.onboarding_config.reminders`)
   and **nothing links cadence → ledger → send**. The schema can record a send but has no
   scheduler row / last-run marker for a reminder job. The structural gap is not a missing
   table but a missing execution pathway + a `last_reminded_at`-style marker on
   `onboarding_progress` (which has `stalled` boolean `:797` but no reminder timestamp).

5. **No session CSV-import surface despite the hook.** (§2.5) `service_sessions.external_ref`
   + partial unique index (`00000000000011:45-48`) were added *for* idempotent CSV import, but
   the column is unused by any code path — schema is ready, the feature isn't. Schema is *not*
   the gap here; the gap is purely application-layer.

6. **Contract-type fields are complete** (not a gap): `contract_type` enum carries `FT/PT/PH/PS`
   (`00000000000013`), `worker_companies.bill_rate_usd` + `session_rate_usd` both present
   (`00000000000011:18-19`), `invoice_lines.kind/sessions_count/session_rate_usd`
   (`00000000000011:77-80`). The data model fully supports PH/PS.

---

## §5 Nice-to-haves (non-blocking) — separated

- **Admin re-scoping** (§2.4): add `setAdminCompanies`; workaround (remove+re-add) exists.
- **Session bulk approve + session CSV import** (§2.5): throughput, schema already prepped.
- **Report exports** (§2.7): payroll-register, payout-file, invoice-list, time exports.
- **`loading.tsx` skeletons** for invoicing/batches/calculate/sessions (admin) and all 5 portal
  authed routes (§3).
- **Pagination/virtualization** on time, payroll, documents, sessions, imports tables (§3).
- **Search/filter** on documents, sessions, (admin) time tables (§3).
- **Mood read/display** path (§2.8) — or remove the widget.
- **"Check emails" Wise recon** stub (§2.6) — wire or remove.
- **FX history** table (§4.3).
- **Delete stray `…session 2.sql`** before cutover (§2.10) — strictly an operational fix.

---

## §6 Re-verification of `RECREATION-RECOMMENDATIONS.md` (doc vs. code)

| Doc claim | Doc says | Code reality | Evidence |
|-----------|----------|--------------|----------|
| R4 `useUnsavedGuard` | `[~]` "built but **not yet wired** into ProfilePanel" | **STALE — it IS wired** into ProfilePanel (and PortalFieldsCard) | `src/components/contractors/ProfilePanel.tsx:4,185` (`useUnsavedGuard({ dirty })` + `guardedClose`); `src/components/config/PortalFieldsCard.tsx:31` |
| R2 mood check-in | `[x]` "real write path; fake-success stub removed" | **Half-true** — write path real, but **read/display never built** (data is write-only) | write `src/db/queries/portal.ts:264`; orphan reader `portal.ts:139-150` never called |
| R3 invoicing | `[x]` "built in-app (Hubstaff import deferred)" | **Accurate** — invoicing built; Hubstaff→invoicing still absent | `src/lib/invoicing/compute.ts`; no Hubstaff path in `src/server/actions/invoicing.ts` |
| R1 #7 "no out-of-band DDL" | `[x]` all schema in migrations | **Mostly true, with a leak**: `wise-payouts` recon cron is **not** scheduled by any migration (only hubstaff is, `00000000000010`) | grep `cron.schedule` → only `00000000000010`; `wise-payouts/index.ts` documents a scheduled twin |
| Gaps table: "Mood check-in write path … no-op that fakes success" | listed as a Low gap to wire-or-remove | wired (write side) — the Gaps-table phrasing is now **outdated** | as above |
| Gaps table: "Invoicing / client billing — port `bill_rate_usd × hours`…" High | implied to need building | built; but the table never flagged **Hubstaff-into-invoicing** or **payment tracking** as separate gaps — both remain open | §2.1, §4.2 |
| Implicit (not in doc): onboarding reminders | doc only mentions reminder *settings* live in `onboarding_config.reminders` (HANDOFF.md:110-111) | **No send path at all** — `onboarding_reminders` table dead; doc never claims sends, but a reader could assume reminders work | §2.2 |
| Implicit: `…session 2.sql` | not mentioned | **stray duplicate migration** present, untracked | §2.10 |

Net: the doc's only materially *wrong* checkbox is **R4 `useUnsavedGuard` (`[~]`)** — it is
done. The doc's *omissions* (Hubstaff→invoicing, invoice payment tracking, reminder send path,
coverage-gap model) are the substantive open gaps.

---

## §7 Coverage note

**Verified directly (read):** money/calc engine (`calc.ts`, `expected-hours.ts`),
payroll mappers + orchestration (`mappers.ts`, `server/payroll.ts`), full baseline schema
+ migrations 0011–0013, `useUnsavedGuard` wiring, duplicate-migration diff, edge-function
inventory, `onboarding_reminders` insert-site grep (zero), `runExpiryCheckNow` caller grep,
`wise-payouts` cron-schedule grep (none).

**Verified via sub-agent sweeps (file:line-cited, spot-checked against direct reads):**
invoicing/Hubstaff (compute, actions, queries, cron, edge fn); overview signals; reminders;
mood; admin re-scoping; Wise recon completeness; reports/exports; bulk ops; PS session UI; the
UI-state matrix across all admin + portal routes.

**Not independently re-derived (relied on sub-agent file:line):** the exhaustive per-screen
`loading.tsx` presence/absence list and a few INFERRED empty-state claims
(`PortalSessions.tsx`, ProcessShell) — flagged INFERRED in §3.

**Confidence:** high on the six §2 blocking gaps (each traced to an absent code path or
missing schema). Medium on a handful of INFERRED UI items. No source/schema/config was
modified; only `audit/05-gaps.md` was written.
