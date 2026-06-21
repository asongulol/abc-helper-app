# 00 — Audit Synthesis · abc-helper-app

**Engagement:** read-only mapping-and-recommendation audit of `abc-helper-app` — a Next.js 16
(App Router) + React 19 + Supabase payroll system: **Hubstaff tracked time → semi-monthly PHP
payroll → Wise draft-only payouts**, with an admin back-office and a contractor self-service
portal. Parity-first rewrite of a legacy single-file SPA.

**Tracks merged here:** [01 Inventory](01-inventory.md) · [02 UI/UX](02-ux.md) ·
[03 Workflows & Algorithms](03-workflows.md) · [04 Database](04-database.md) ·
[05 Gaps](05-gaps.md). This document de-duplicates overlapping findings, surfaces (does not
average) cross-track disagreements, and prioritizes. Full evidence with `file:line` citations
lives in the five track files; this is the decision layer.

**Ground-truth notes that shaped the audit:**
- The global `~/CLAUDE.md` describes a different project ("ABBI EIS", Angular/Nx/NestJS). It
  **does not apply** to this repo and was ignored by all tracks.
- **The UX standard your brief named (`ux-ui-guidelines-v2.md`) does not exist** anywhere on
  disk. Per your direction, Track 2 used the installed **impeccable** skill as the governing
  standard (refs cited as `impeccable/reference/*.md`). *Also note:* several components claim to
  follow an in-repo `docs/ux-ui-guidelines.md` (e.g. [EmptyState.tsx:5](src/components/ui/EmptyState.tsx#L5)) — **that file is also absent**, so those comments are unverifiable.
- Track 4's schema source of truth is the **migration SQL** (`supabase/migrations/`), since
  `config.toml` points at a local/dev Supabase, not a live cloud project. No Supabase MCP
  write/advisor calls were made.

---

## §0 System goals (INFERRED — please confirm)

The brief had no explicit goals statement, so these are inferred from `README.md`,
`package.json`, `docs/money-core-spec.md`, and `docs/RECREATION-RECOMMENDATIONS.md`. Every
downstream "gap" and "orphan" verdict is relative to this list, so **confirm or correct it
first** (also logged in §7):

1. Ingest Hubstaff tracked time → compute semi-monthly PHP payroll on an **integer-centavos**
   money core (never floats).
2. Pay out via **Wise in draft-only mode** — money never moves from the app (owner funds in the
   Wise UI); plus reconciliation/backfill.
3. **Employer/client model:** payroll booked at `companies.kind='employer'`; clients are billing
   tags carrying `bill_rate_usd`/`session_rate_usd` → **client invoicing**.
4. Contractor **onboarding** + immutable **e-sign agreement ledger**; **document review**
   (approve/needs-replacement/waive/defer) with expiry tracking.
5. **Time approval** (Hubstaff sync + CSV import + manual override) and **per-session (PS)** EI
   billing alongside **per-hour (PH)/FT/PT**.
6. **Contractor portal** self-service: pay slips, time, sessions, docs, profile, onboarding.
7. **Multi-tenant isolation** via RLS; secrets server-side only; append-only audit log.

---

## §1 Master catalog — pages/modals with appropriateness verdict

Verdict legend: **keep** · **revise** (fix in place) · **consolidate** (merge with another) ·
**remove** (delete/collapse). Merges Track 1's inventory with Track 2's UX verdicts. Detail &
citations in [01](01-inventory.md)/[02](02-ux.md).

### Admin surface

| Screen / modal | Pattern | Verdict | One-line reason |
|---|---|---|---|
| Overview (`/overview`, landing) | page | **revise** | Real "needs-attention" board, but several signals are fake/dead — see §6/§3 (hardcoded "Payout issues = 0", orphaned AlertsBanner, non-functional Data-quality/Refresh). |
| Contractors (`/contractors`) | page + table | **keep** | Correct full-page roster CRUD. |
| ↳ ProfilePanel (4-tab) | modal | **revise** | A 700px 4-tab record is a workspace → route/drawer, not a dialog. |
| ↳ AddContractorModal (quick) | modal | **remove** | Redundant with the Wizard's step 1; two "add contractor" entry points. |
| ↳ AddContractorWizard (3-step) | modal | **revise** (keep) | Keep the canonical hire path; harden (progressbar role, etc.). |
| ↳ BulkImport / PullWise / Announcements / danger-confirms | modal | **keep** / **consolidate** | Announcements authoring belongs under Config, not Contractors. |
| Hiring & Onboarding (`/onboarding`) | page + table | **keep** | Distinct hire→complete lifecycle. |
| ↳ OnboardingDrilldown (~9 nested modals) | modal | **revise** | 1,294-line modal stacking 9 overlays → route with sections. |
| Documents (`/documents`) | page | **keep** | Expiry tracking; note file-upload is a Phase-2 stub ([DocumentsClient.tsx:167](src/components/documents/DocumentsClient.tsx#L167)). |
| Time & Approval (`/time`) | page + inline | **keep** | Exemplary (inline expand, undo-over-confirm). |
| **Calculate (`/calculate`)** | page → PayrollShell | **consolidate→remove** | Renders the **same `PayrollShell`** as `/payroll`. Duplicate route. |
| **Payroll (`/payroll`, not in nav)** | page → PayrollShell | **keep (canonical)** | Keep as the one payroll route; off-nav today. |
| ↳ MiscModal | modal (`escClose=false`) | **revise** | Removes keyboard escape; icon-only delete rows. |
| Process and Pay (`/process`) | page (nav-only) | **consolidate** | Thin pass-through; both actions bounce to `/payroll`. Fold in. |
| Review & Recon Batches (`/batches`) | page | **keep** | Genuinely distinct Wise reconciliation job. |
| Reports (`/reports`) | page (5 stacked) | **revise** | "Payout by period" duplicates the Payroll batch list; split the 5 reports. |
| Sessions (`/sessions`) | page | **keep** | EI flat-fee entry/approval; uses `window.confirm` for delete (revise). |
| Invoicing (`/invoicing`) | page | **keep** | Correct preview→generate flow. |
| Imports (`/imports`) | page | **keep** | Recovery tool with dry-run + type-to-confirm. |
| Audit Log (`/audit`) | page | **keep (gold standard)** | Pagination + filter + accessible expander — the model for the app. |
| Configuration (`/config`) | page → 7 modals | **revise** | Settings is full-page/section territory; modal-per-panel is the weaker pattern. |
| ↳ AdminsModal (shell) | modal | **revise** | Uses `window.confirm()`; lacks admin re-scoping (§3, §5). |
| Command Palette (⌘K) | modal | **keep (best-in-app)** | Fully keyboard-accessible. |
| Print routes (pay slip/invoice/agreement) | page (auto-print) | **keep** | Minor: signature `alt` should name the signer. |

### Contractor portal surface

| Screen / modal | Pattern | Verdict | One-line reason |
|---|---|---|---|
| Portal shell (bottom-tab/sidebar) | shell | **revise** | Solid; **missing skip-to-content link** (admin has one). |
| Home / Dashboard (`/portal`) | page | **keep** | Greeting + announcements + pay/activity + toolkit. |
| ↳ DocReminderOverlay | custom sheet | **revise** | Hand-rolled dialog duplicating the Modal primitive with weaker focus handling. |
| ↳ ToolsPopup | modal | **keep** | One-time credential reveal. |
| Pay slips (`/statements`) | page (expand cards) | **keep** | Expanders use `div role=button` → prefer `<button>`. |
| Time (`/time`) | page | **keep** | Read-only; same expander nit. |
| Sessions (`/sessions`) | page | **keep** | Contractor EI submission; JS-only validation. |
| Docs (`/docs`) | page | **keep** | Good empty/busy states. |
| Profile (`/profile`) | page (4 tabs) | **keep** | Tabs not true ARIA tablists. |
| Onboarding (`/onboarding`, not in nav) | page (3 stages) + 2 modals | **keep (harden)** | Signature canvas inaccessible; scroll-gate is fabricated (§3). |
| Logins (`/login`, `/portal/login`) | page | **keep** | Clean; admin login mode toggle lacks a current-state indicator. |

**Orphan/dead components (remove):** `config/AdminsCard.tsx` (never imported — confirmed by
grep; live UI is the shell `AdminsModal`), `overview/AlertsBanner.tsx` (never imported),
`overview.ts getPeriodCounts` (dead), the inert `wiseRates()` action, the permanently-disabled
"Check emails" button.

---

## §2 Cross-track agreements (flagged by ≥2 tracks → highest confidence)

1. **`/calculate` and `/payroll` are the same screen** (both render `PayrollShell`), and in-app
   links disagree on which URL to use — sidebar → `/calculate`, Overview/Process → `/payroll`.
   *(T1 §7.1, T2 §3.1 + top issue.)*
2. **Stray duplicate migration** `00000000000013_…session 2.sql` — byte-identical, untracked,
   shares the `…13` version prefix; risks aborting `supabase db reset` at cutover. **Delete it.**
   *(T4 §7.12, T5 §2.10.)*
3. **`window.confirm()` for destructive actions** ([AdminsModal.tsx:113](src/components/shell/AdminsModal.tsx#L113), [SessionsClient.tsx:117](src/components/sessions/SessionsClient.tsx#L117)) breaks the app's own
   `ConfirmDangerModal` pattern. *(T2 B2.)*
4. **Process page + Reports "payout by period" are redundant** with the Payroll batch list.
   *(T1 §7, T2 §3.2/§3.3.)*
5. **Modal overuse where routes/sections belong** — ProfilePanel (4 tabs), OnboardingDrilldown
   (9 nested), Config (7 panels). *(T1 §1.2, T2 §2/§7.)*
6. **The "no scheduler" cluster** — `onboarding_reminders` is a dead table (no inserts), document
   expiry is admin on-demand only, and the `wise-payouts` recon cron is **not** captured as a
   migration (only Hubstaff's is). *(T5 §2.2/§2.6, T4 §1, T3 Flow 3.)*

---

## §3 Disagreements & resolutions (surfaced, not averaged)

| # | Tension | Tracks | Resolution (verified) |
|---|---|---|---|
| D1 | Is `config/AdminsCard.tsx` dead? | T1 "dead/unimported" vs T5 cites it as the live admin-scope UI | **DEAD.** Grep: only its own `interface`+`export` exist; never imported. The live roster UI is `shell/AdminsModal` ([AdminShell.tsx:128](src/components/shell/AdminShell.tsx#L128)). T1 correct; T5 misattributed the file → its §2.4/§3 "no re-scope" gap is real but belongs to `AdminsModal`. **Remove `AdminsCard.tsx`.** |
| D2 | Is `mood_checkins` live or orphaned? | T4 "NOT orphan — read by `fetchLatestMoodCheckin`" vs T5 "write-only, read never called" | **WRITE-ONLY.** Grep: `fetchLatestMoodCheckin` has no caller; the table is written by `insertMoodCheckin` but **never displayed**. T5 correct; T4 overstated "read by" (the function exists but is dead). → Wire a read surface **or** remove the widget. |
| D3 | Is `useUnsavedGuard` wired? | T1/T5 "wired" vs `RECREATION-RECOMMENDATIONS.md` R4 `[~]` "not yet wired" | **WIRED.** Grep confirms [ProfilePanel.tsx:185](src/components/contractors/ProfilePanel.tsx#L185) + [PortalFieldsCard.tsx:31](src/components/config/PortalFieldsCard.tsx#L31). The doc checkbox is **stale** — update it. (Project memory does not make this claim.) |
| D4 | `onboarding_reminders` — written or not? | T4 "RLS on, 0 policies; written-via-service? (ASSUMPTION)" vs T5 "zero insert sites (grep)" | **NOT written at all** → fully dead table. T5 resolves T4's open assumption. |
| D5 | Holiday observance — bug or spec? | T3: code shifts weekend holidays onto weekdays so they DO reduce expected hours; spec §4 says they should NOT | **Code is right, spec is stale.** Parity data matches the code ([T3 §2 holiday row](03-workflows.md)). → Fix `docs/money-core-spec.md` text + add a weekend-observance parity assertion. Do **not** change the code. |

No track produced a finding another track contradicted on the money-core math, the Wise
draft-only invariant, or the RLS financial-isolation conclusion — those are corroborated.

---

## §4 Prioritized recommendations roadmap (impact × effort)

### Quick wins — low effort, high/medium impact
| Action | Impact | Source |
|---|---|---|
| Delete stray `…session 2.sql` migration | High (prevents cutover abort) | T4/T5 |
| Scope `pay_periods_contractor_read` to the worker's companies | High (closes cross-tenant leak) | T4 §7.1 |
| Change `audit_log` RLS from `FOR ALL` → SELECT+INSERT only | High (trail integrity not trigger-dependent) | T4 §7.2 |
| Add money `CHECK (… >= 0)` + `invoices.status` CHECK + validate `payments.misc_items` shape | High (payroll integrity) | T4 §4/§7 |
| Merge `/calculate`≡`/payroll` to one route+label; fix mismatched links | High (navigation clarity) | T1/T2 |
| Replace the two `window.confirm()` with `ConfirmDangerModal` | Medium (consistency, a11y) | T2 B2 |
| Remove dead code (AdminsCard, AlertsBanner, getPeriodCounts, wiseRates, "Check emails", hardcoded "Payout issues" tile) | Medium (clarity/maintenance) | T1/T3/T5 |
| Add missing `loading.tsx` skeletons (invoicing/batches/calculate/sessions + 5 portal routes) | Medium (perceived perf) | T2/T5 |
| Update stale `money-core-spec.md` holiday text + the `RECREATION-RECOMMENDATIONS`/memory `useUnsavedGuard` checkbox | Medium (don't mis-audit later) | T3 D5 / D3 |

### Medium — build a thing, contained scope
| Action | Impact | Source |
|---|---|---|
| **One scheduler** for onboarding reminders + document-expiry sweep + `wise-payouts` cron, all captured as migrations | High (unblocks Goals 4 & part of 2/3) | T5 §2.2/§2.6 |
| On-demand "refresh hours from Hubstaff for this billing window" in Invoicing | High (billing accuracy — under-billing risk) | T5 §2.1, T3 Flow 4 |
| Fix Overview signals: real "Payout issues" query, surface AlertsBanner detail, add doc-expiry signal, per-tile error states | Medium-High | T3 Flow 6 |
| Decide period `paid` state: write it in `markPaid`/reconcile, **or** drop `'paid'` from enum+UI | Medium (state machine currently stalls at `locked`) | T3 §4.1 |
| Modal a11y: add `inert`/`showModal()` to the Modal primitive; real ARIA tablists; link form errors (`aria-invalid`/`aria-describedby`); fix bespoke mouse-only expanders | Medium (WCAG AA) | T2 M1–M9 |
| Signature canvas a11y + **real** scroll-to-end tracking (currently hardcoded `true`) | Medium (a11y + legal evidence) | T2 B1, T3 §4.5 |
| Add `rates` overlap guard; index `payments.worker_id`, `invoice_lines.worker_id`, `worker_companies.worker_id` | Medium (integrity + payroll-join perf) | T4 §4 |
| Unify the two attribution matchers; extract one `composeNet()` helper | Medium (correctness convergence) | T3 §3 |
| Invoice payment tracking columns (`amount_received_usd`, `paid_on`, `payment_ref`) + UI | Medium (AR side of Goal 3) | T5 §4.2 |
| Pagination/virtualization on time, payroll, documents, sessions, imports tables | Medium (scalability cliff) | T5 §3 |
| Session bulk-approve + session CSV import (schema hook already exists) | Medium (EI throughput) | T5 §2.5 |
| Admin re-scoping (`setAdminCompanies`) in AdminsModal | Low-Medium | T5 §2.4 |

### Larger refactors — high effort, do deliberately
| Action | Impact | Source |
|---|---|---|
| Decompose heavy modals (ProfilePanel, OnboardingDrilldown, Config) into routes/sections | Medium-High (cognitive load, focus robustness) | T1/T2 |
| Fold Process into the payroll route; make one canonical period list (dedupe Reports) | Medium | T1/T2 |
| Coverage-gap detection — needs a coverage/scheduling **data model** before any overview widget | Medium (currently unbuildable) | T5 §2.3/§4.1 |
| PHI/HIPAA posture: column-level crypto for `workers.payout_account`/`wise_recipients` + `onboarding_signatures.signature_data`; reduce `SUPABASE_SERVICE_KEY` blast radius; tighten `GRANT ALL TO anon` | High (compliance) but large | T4 §6/§7.4-5 |
| DB-enforced append-only e-sign ledger (block UPDATE/DELETE on signatures) | Medium (evidentiary integrity) | T3 §4.5, T4 |

---

## §5 Consolidated remove / consolidate list

**Remove (routes/components):**
- `/calculate` as a separate route — alias of `/payroll` (keep `/payroll`, give it the nav slot).
- `AddContractorModal` — redundant with `AddContractorWizard`.
- Dead components/functions: `config/AdminsCard.tsx`, `overview/AlertsBanner.tsx`,
  `overview.ts getPeriodCounts`, inert `wiseRates()`, disabled "Check emails" button, hardcoded
  "Payout issues" tile.
- `mood_checkins` **read** path decision: either build a display or remove the write + widget
  (currently write-only).

**Consolidate:**
- `/process` → fold into the payroll route as a state-filtered view (keep `/batches` separate).
- Reports "payout by period" → link to the canonical Payroll list instead of duplicating it; split
  Reports' 5 stacked sections into tabs/sub-routes.
- Authoring scattered across surfaces (Announcements on Contractors, Agreement templates on
  Onboarding) → surface only from Config.
- `DocReminderOverlay` custom sheet → the shared `Modal`/sheet primitive.

---

## §6 Database findings — highest risk first

(Full table-by-table coverage, FKs, RLS policies in [04-database.md](04-database.md).)

**Security / isolation**
1. **`pay_periods_contractor_read` is not tenant-scoped** — predicate is only
   `my_worker_id() IS NOT NULL AND is_onboarded()`, so **any onboarded contractor can read every
   company's pay-period schedule** ([baseline:1679](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1679)). Cross-tenant metadata leak. *Quick fix.*
2. **`audit_log` RLS is `FOR ALL`** — a scoped admin can UPDATE/DELETE their company's trail at
   SQL level; only a (droppable) append-only trigger from `..05` prevents it ([baseline:1571](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1571)).
3. **`admin_users_read` exposes all admins cross-tenant** (emails, roles, names) to any admin
   ([baseline:1536](supabase/migrations/00000000000001_baseline_abc_schema.sql#L1536)).
4. **Authz is procedural once the service-role client is used**, and every table has
   `GRANT ALL TO anon, authenticated, service_role`. RLS is the only DB-level defense; one
   forgotten guard in a future server action = unrestricted cross-tenant access. The
   `worker_tools` decryption key lives in-DB (`app_secrets`) → service-key compromise defeats it.
5. **Plaintext financial/biometric PII** — `workers.payout_account`/`wise_recipients` and
   `onboarding_signatures.signature_data` rely only on platform at-rest encryption (weak for a
   BAA/HIPAA posture given the BAA template ships).

**Integrity**
6. **No money/ratio CHECK constraints** anywhere on `payments`/`rates`/`invoices`/`invoice_lines`
   — negative pay and unbounded `performance_ratio` are insertable.
7. **`payments.misc_items` is unvalidated JSONB** yet financially material (real deductions in
   net). Only `jsonb_typeof='array'` enforced.
8. **`invoices.status` is unconstrained text** while live-invoice uniqueness + the `invoice_no`
   allocator depend on `status <> 'void'` — a typo bypasses both.
9. **No overlap guard on `rates`** effective ranges → ambiguous "current rate."
10. **Cascade blast radius** — `DELETE FROM companies` wipes a tenant's entire payroll/invoicing
    history; deleting a worker cascades nearly everything worker-scoped. Relies on the app never
    hard-deleting.

**Performance / hygiene**
11. Unindexed hot-path FKs: `payments.worker_id`, `invoice_lines.worker_id`,
    `worker_companies.worker_id`.
12. Stray duplicate migration (see §2).
13. Hard-coded project ref + anon JWT in the cron migration `..10` (low severity; hygiene).

**Confirmed-good (don't "fix"):** financial RLS isolation **holds** (admins can't cross
companies; contractors can't see each other); Wise draft-only is enforced at **three** layers
(no funding code exists, documented hard-stops, build-time guardrail scanner); `invoice_no`
allocation is atomic (`..04` advisory-lock + `max()+1`); avatars data-URI smell was fixed
(`..02` storage bucket); money math is parity-verified to the centavo against 117 real rows.

---

## §7 Assumptions & open-questions log (aggregated — for your review)

**Goals & standards**
- **A1.** The 7 system goals in §0 are **inferred** — confirm/correct before acting on any gap.
- **A2.** The UX standard file `ux-ui-guidelines-v2.md` (and the in-code `docs/ux-ui-guidelines.md`)
  are absent; **impeccable** was substituted per your instruction. Confirm that's the lasting
  standard, or point to the real file.

**Intent questions (the audit can't answer — product/history needed)**
- **Q1.** Is `/calculate` vs `/payroll` intentional, or a migration alias? (Recommend collapsing.)
- **Q2.** Should the period `paid` state exist? It's in the enum + UI but **never written** —
  wire it or drop it.
- **Q3.** Should `mood_checkins` have a display, or be removed? (Currently write-only.)
- **Q4.** Is the `wise-payouts` recon cron scheduled out-of-band in the Supabase dashboard? Not in
  the repo. (If yes, capture it as a migration.)
- **Q5.** Coverage-gap detection (Goal-ish, on Overview) has **no supporting data model** — do you
  want scheduling/coverage targets, and at what grain?
- **Q6.** Is the contractor able to draw a signature without a mouse a hard requirement? (Drives
  whether typed-name becomes the primary e-sign method.)

**Notable INFERRED items carried from the tracks (verify against live system before relying on)**
- The service-role authz re-check conclusion (T4 §5d) reflects **current** app code; it's a
  TypeScript-level guarantee, not DB-enforced.
- Calc-time attribution lacks the loose-key fallback that import-time has (T3 §2) — a loosely-
  matched worker without a backfilled `worker_id` can fall to `unattributed` at calc time.
- Wise matcher decides the winning transfer on coarse list-row `created` dates, then fetches
  precise dates afterward (T3 §3) — low false-match risk, mitigated by ±₱1 tolerance + tie guards.
- `onboarding_reminders` and `app_secrets.getAppSecret()` runtime usage couldn't be confirmed from
  migrations alone (T4 §8); T5 grep found `onboarding_reminders` has **zero** inserts (dead).
- Several empty/loading-state and `loading.tsx`-absence claims (T5 §3) and the contrast/focus-trap
  findings (T2 m3/M3) were **not** verified in a running browser — a live `impeccable audit` +
  contrast pass would confirm them.
- Schema drift acknowledged in-source: the baseline migration was edited in place (`..03`), so a
  fresh local DB and prod may differ on `deduction_php`/`shortfall_php` (T4 §8).

**Stale documentation to correct (found during the audit)**
- `docs/money-core-spec.md` §4 holiday-observance text contradicts the (correct) code (D5).
- `docs/RECREATION-RECOMMENDATIONS.md` R4 `useUnsavedGuard` `[~]` says "not yet wired" — it **is**
  wired (D3). (Project memory does not repeat this; it's doc-only.)

---

## §8 The first 3–5 changes I would make, and why

1. **Close the two cross-tenant RLS leaks + delete the stray migration** (one tiny migration).
   Scope `pay_periods_contractor_read` to the worker's companies and make `audit_log` SELECT+INSERT
   only; delete `…session 2.sql`. *Why first:* these are the highest risk-to-effort items in the
   whole audit — a real cross-tenant data leak and a cutover-blocking file, both fixed in a few
   lines, and both are security/safety, not preference.

2. **Add DB integrity guards in the same migration:** money `CHECK (>= 0)` on
   payments/rates/invoices/invoice_lines, an `invoices.status` CHECK, a `rates` overlap guard, and
   `misc_items` shape validation. *Why:* payroll is the product; today the database will accept
   negative pay and a status typo that silently defeats invoice uniqueness. Cheap, and it protects
   the one thing that must never be wrong.

3. **Collapse `/calculate`≡`/payroll` (and fold `/process`) into one route with one nav label,
   and fix the mismatched in-app links.** *Why:* it's the single biggest source of navigational
   confusion (two URLs + two names for one workspace, with the app's own links disagreeing), it's
   low effort, and it shrinks the surface every other track has to reason about.

4. **Build the one scheduler that's missing** — onboarding reminders, document-expiry sweep, and
   the `wise-payouts` recon cron — all captured as migrations. *Why:* this single mechanism
   unblocks the largest cluster of "configured-but-never-executes" gaps (Goal 4 reminders/expiry,
   and reproducible Wise reconciliation), which no amount of UI work can substitute for.

5. **Sweep the dead code and stale docs.** Remove `AdminsCard`, `AlertsBanner`, `getPeriodCounts`,
   `wiseRates`, the "Check emails" button, and the hardcoded "Payout issues = 0" tile; correct the
   stale holiday spec and the `useUnsavedGuard` checkbox/memory. *Why:* these are confirmed dead or
   misleading (grep-verified), they actively mislead the next reader/auditor, and clearing them
   makes the genuine remaining work legible.

> Items deliberately **not** in the first five but high value next: Modal/`inert` + ARIA-tablist
> accessibility pass, Hubstaff-refresh-into-invoicing, signature-canvas a11y + real scroll-gate,
> and the heavy-modal→route decomposition. These are larger and benefit from the cleanup above
> landing first.
