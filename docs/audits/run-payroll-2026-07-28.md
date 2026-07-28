# Run Payroll — end-to-end audit

**Date:** 2026-07-28 · **Base:** `main` @ 4b34cd9 · **Suite at audit time:** 522 tests / 57 files, all green
**Scope:** the `Run payroll` nav group — `/time` (Time & Approval) → `/payroll` (Calculate) → `/process` (Process and Pay), plus every modal, export and reconciliation path behind them (~9,000 lines).
**Method:** four independent audits (period semantics, Calculate, Time & Approval, Process and Pay). Findings deduplicated; the pay-date defect was reported independently by three of the four.

**Rendered version:** https://claude.ai/code/artifact/1af8f1b7-9ec6-41df-b0e0-2d46f6ff78f7

**Verification status.** Findings marked **[verified]** were re-read against source directly after the audit reported them. Unmarked findings carry their auditor's `file:line` but were not independently re-read. RP-25 is explicitly **suspected** — it depends on legacy-app timing that cannot be confirmed from this repo.

**Totals:** 2 critical · 15 high · 24 medium · 14 low.

---

## The pay schedule this was audited against

Semi-monthly, half-month arrears:

- Work on days **1–15** of month M is paid **by the end of month M**.
- Work on days **16–EOM** of month M is paid **by the 15th of month M+1**.
- **Processing and payment dates are not fixed.** Days 1–15 may be processed and paid on any day from the 16th to month end; days 16–EOM on any day from the 1st to the 15th. `pay_date` is a **deadline**, not an appointment.

**This flexibility is genuinely supported.** No date-based gate exists anywhere in the state machine — `lockPeriod`, `unlockPeriod`, `markPaid`, `markAllUnpaid` and Wise drafting all key off period *state*, never the calendar. The DB trigger (migration 18) enforces state, not dates. `pay_periods` has no date constraint beyond `period_end >= period_start`.

The defects below are in what the system **records** and **reconciles**, not in when it lets you run.

---

## Cross-reference: prior audit (2026-07-12)

Source: `ABC Helper — E2E Clickthrough Audit · 2026-07-12` (artifact `cc624585`), 48 findings.

> **The artifact's own fix-status text is stale.** It was written 2026-07-12 and still says batches B–E are "not yet started". Work continued on 2026-07-13: **all batches A–E were completed** and are now in `main` (verified by presence of `src/lib/errors.ts`, `src/proxy.ts` with no `src/middleware.ts`, and `tests/lib/errors.test.ts` / `tests/lib/profile/validate.test.ts` / `tests/lib/names.test.ts`). The original commit SHAs are not ancestors of `main` because the branch was squash-merged. Treat the artifact as a findings catalog, not a status board.

| Prior | Actual status | Relationship to this audit |
|---|---|---|
| **#028** — "Different pay date shown on /process vs /payroll for batches locked this session" | **CLOSED 2026-07-13 as won't-fix** — "no persisted bug (both surfaces read the same stored `pay_date`); transient UI only" | **RP-03 reopens this.** The close was reached on an incomplete diagnosis: it asked whether the two surfaces *agree* (they do — both read the same stored value) rather than whether the stored value is *correct* (it is not — `lockPeriod` writes `periodEnd` into `pay_date`). The symptom was cosmetic; the cause is not. **Re-open and re-grade to High.** |
| **#025** — default holiday set is US federal; panel copy promised a PH fallback | **CLOSED 2026-07-13 as copy-only**, by explicit owner decision: holidays are listed in the config panel and admin-editable, so there is no automatic PH fallback; the copy was corrected and the pay-affecting default set deliberately left alone | **No conflict with this audit.** Since holidays are admin-configured rather than defaulted, the "holiday logic verified correct" note stands on its own. Standing owner decision — do not re-litigate or swap the default set. |
| **#016** — raw Postgres/Zod messages surfaced to users | **Done** — `src/lib/errors.ts` `humanizeError()`, all action `error:` returns routed through it | Complementary, not duplicate. #016 stopped raw errors *leaking*; RP-19 / RP-48 / RP-26 are errors *swallowed* into healthy-looking empty states. The outbound path is handled; the inbound one isn't. |
| **#001 + #009** — session posts to newest open draft, not the date-covering period | **Fixed** `03086ab` (date-containment in draft resolution) | Confirmed still correct in code. **RP-01 is the remaining gap in the same area:** routing is right, but sessions paid through a locked regular period are never stamped `paid_at`, so they stay re-payable. Not a duplicate. |
| **#008 / #007 / #019 / #020 / #042 / #043** — sessions + imports (batch A) | **Fixed** | Verified; no regression observed. RP-13 (overwrite mode zero-fills and un-approves) is a distinct CSV defect that batch A did not touch. |
| **#030** — payroll selected batch not in URL | **Done** (batch B, `6216243`) | Adjacent to RP-25 (landing-period selection), distinct defect. |
| **#018**, **#021** | Fixed but **never click-tested live** (per owner notes) | Outside this audit's scope; still open verification debt. |

---

## Critical

### RP-01 — Sessions paid through a regular period are never marked paid **[verified]**

**Where:** `src/server/actions/payroll.ts:404` · `src/db/queries/payroll.ts:899–909`

`calculateDraft` pays approved sessions via the windowed sum (`fetchSessionUnitsByWorkerByDate`, filtered on `paid_at IS NULL`), but `lockPeriod` only touches `pay_periods` — it never stamps `paid_at` on the sessions it just paid. `markSessionsPaid` has exactly two callers, both off-cycle ledger paths (`payroll.ts:1192`, `:1517`). Neither is `lockPeriod`. The comment at `sessions.ts:322` describes a marker that nothing sets, and no DB trigger sets it either.

**Scenario:** Add a session dated Jul 3 with "Approved" ticked (`createSession approve:true` — no ledger row, `paid_at` null). Calculate Jul 1–15 → the PS gross includes it. Lock and pay. The session still appears in `/time`'s "Recently added" queue with an **Add** button (`AddSessionForm.tsx:785`) and in the off-cycle unpaid picker. One click on "Off-period (pay now)" → `addApprovedSessionsToPeriod` guards only on `s.paidAt`, which is still null → paid a second time.

**Fix:** On `lockPeriod`, stamp `paid_at` / `paid_pay_period_id` on the approved, in-window, `paid_at IS NULL` sessions of the period's per-session workers — the exact set the calc summed. Unlock must clear them.

### RP-02 — Wise batch CSV can denominate peso amounts as US dollars **[verified]**

**Where:** `src/lib/payroll/wise-batch.ts:80–81` · `src/components/process/ProcessPay.tsx:478`

`buildWiseBatch` always writes `amountCurrency='target'` with `amount = netPhp` — a peso figure, unconditionally. The Target currency select offers **USD**.

**Scenario:** Switch Target to USD. A row with net ₱50,000 exports as `…,USD,USD,target,50000,…`. Wise reads it as **$50,000 ≈ ₱2.9 M** — roughly 58× overpay, on every row in the file. The batch preview still shows plausible peso numbers. Funding is manual in Wise so a human would likely catch the total, but nothing in the app does.

**Fix:** Remove the USD option (payouts are PHP-only per `docs/money-core-spec.md`) and make `buildWiseBatch` throw when `targetCurrency !== 'PHP'`. No test covers a non-PHP target.

---

## High

### RP-03 — Locking overwrites the arrears pay date with the period end **[verified]** · *prior #028*

**Where:** `src/server/actions/payroll.ts:404` → `src/db/queries/payroll.ts:905`

The period is created with the correct date (`upsertOpenPeriod`, `payroll.ts:561`, from `periodFor().payDate`). Then `dbLockPeriod(db, period.id, input.periodEnd)` passes the period end into a parameter named `payDate`, written straight to `pay_periods.pay_date`.

**Scenario:** Lock Mar 1–15 → `pay_date` becomes Mar 15, should be Mar 31. Lock Mar 16–31 → Mar 31, should be Apr 15. The stored date sits *before the payment window opens* — never a possible pay date under the arrears rule.

**Inherited by:** Process & Pay header (`ProcessPay.tsx:314`), mark-paid date default (`:258`), individual-payments CSV (`individual-payments.ts:47`), payslip (`PaySlip.tsx:62`), portal statements (`PortalStatements.tsx:81`), reports (`reports.ts:121`), and the Wise matcher anchor (`matcher.ts:48`).

**Fix:** Drop `pay_date` from the `lockPeriod` UPDATE — it was already correct at creation. Off-cycle batches set start = end = pay date, so they are unaffected either way. Optionally also stop trusting the client-supplied `payDate` in `CalculateDraftSchema` (see RP-66).

### RP-06 — The auto-save discards every server result **[verified]**

**Where:** `src/components/payroll/PayrollShell.tsx:469`

The debounced batch save awaits `updatePaymentRowAction` per row and never reads `res.ok`. Zod rejections, a period locked by another admin mid-edit, overflow, network — all swallowed, while the optimistic row (`recomputeRow`) keeps displaying the edited value.

**Scenario:** Type `-500` into a Gross cell (the input has no `min`). The screen drops net by ₱500. The server rejects with "Invalid input"; nobody sees it. You lock believing net is N−500; the DB locks at N.

**Fix:** Check each result; toast and reload the row on failure. The server-side guard already exists — the ignored result is the bug.

### RP-07 — A gross override cannot be reverted, and loses its marker while keeping its value **[verified]**

**Where:** `src/components/payroll/PayrollShell.tsx:99` · `src/server/actions/payroll.ts:567,575`

Two halves of one defect. Client: `computedGrossPhp: p.grossPhp` seeds "computed" from the *stored* gross, so after any reload the ↺ button reverts to the override itself. Server: clearing an override writes `centavosToPhp(grossCur)` — the current, overridden amount — and sets the note to `null`.

**Scenario:** Computed ₱18,182; override to ₱15,000 (blue cell, note records the original). Next visit, click ↺ expecting ₱18,182 → you get ₱15,000, note erased, row now carries a manual amount with **no override marker and no audit trail**. It locks and pays looking clean. On the second save the note regenerates as "computed 15000" (`payroll.ts:565`, `grossCur` already overridden), destroying the last record of the true figure.

**Fix:** Persist the computed gross in its own column (or structured note) and restore *that* on clear; seed `computedGrossPhp` from that field.

### RP-08 — "Mark all paid" regresses reconciled rows and overwrites their true paid date **[verified]**

**Where:** `src/db/queries/payroll.ts:1105` · `src/components/process/ProcessPay.tsx:77`

`markPaymentsPaid` sets `status='sent', paid_at=now` with **no status filter**; the UI treats anything `!== 'sent'` as unpaid. Neither DB trigger protects `status`/`paid_at`.

**Scenario:** A paid period is reconciled on `/batches` (rows → `reconciled`). Reopen `/process?period=<id>` (the page allows `paid` state) → every row reads "pending". Click Mark all paid to tidy up → all rows regress to `sent` and the real Wise send date (e.g. Jun 30) is replaced with today. Reporting dates corrupt silently.

**Fix:** `.in('status', ['draft','queued','failed'])` on the update; compute `unpaidIds` from those three states; render `reconciled` properly (RP-57).

### RP-09 — No server-side guard against drafting the same payment into Wise twice

**Where:** `src/server/wise/service.ts:167–193, 249–304, 198–209`

Neither `serviceDraft` nor `serviceBatch` skips rows that already carry a `wise_transfer_id` — only the UI filters (`ProcessPay.tsx:106`, `WisePayoutsPanel.tsx:54`). `setWiseTransferIdSafe` overwrites, orphaning the first transfer.

**Scenario:** Two admins (or two tabs) both see a row as undrafted; both hit "Pay via Wise API". Wise holds two ₱50,000 drafts; the DB remembers the second. Fund the batch → double pay. The matcher's ghost filter won't catch it — it filters only cancelled transfers, and both are live.

**Fix:** Skip rows with non-null `wise_transfer_id` in both service functions (`status: 'skipped'`, reason "already drafted") — one line, at the layer all callers share.

### RP-10 — Unlocking silently decouples live Wise drafts from their payment rows

**Where:** `src/server/actions/payroll.ts:425–474` · `src/db/queries/payroll.ts:710–723`

A locked period with drafted-but-unfunded transfers unlocks with no check. Once open, recalc can change `net_php` or `pruneDraftPaymentsExcept` can delete the row — regardless of `wise_transfer_id`.

**Scenario:** Lock → draft ₱48,000 → spot a time error → unlock → recalc to ₱45,500 (or the row is pruned). The ₱48,000 draft is still live in Wise, and the app has no record of it. Bulk-fund later → overpay, unreconcilable.

**Fix:** Refuse (or hard-confirm) unlock when any payment in the period has a `wise_transfer_id` in `draft`, instructing the admin to cancel in Wise first.

### RP-11 — Time queries silently truncate at 1,000 rows, including the one feeding gross pay **[verified]**

**Where:** `src/db/queries/payroll.ts:21–42` · `src/db/queries/time.ts:42–57, 66–84` · cap at `supabase/config.toml:18`

`fetchApprovedTime`, `fetchPeriodEntries` and `fetchUnpaidEntries` have no `.limit()` and no pagination, so PostgREST caps them at `max_rows`. The codebase knows about this cap — `fetchSessionUnitsByWorkerByDate` sets `.limit(100000)` explicitly (`payroll.ts:166`). These three do not.

**Scenario:** 63 contractors × a 16-day period ≈ 1,008 daily rows. The overflow is dropped from the calculation with no error — the last workers are simply underpaid. The cross-period "all unpaid" view hits the cap far sooner.

> **Confirm the prod threshold before sizing this.** `max_rows = 1000` is verified in `supabase/config.toml`, which governs the **local** stack. Hosted Supabase defaults to the same, but yours may have been changed.

**Fix:** `.range()` pagination, or an explicit high limit plus a row-count assertion that throws at the cap rather than truncating.

### RP-12 — Salaried catch-up can double-pay after unlock + recalculate; the guard is a comment

**Where:** `src/server/actions/payroll.ts:1310–1316` (JSDoc), `425–474` · `src/lib/payroll/mappers.ts:119–120`

`basis='salaried_hours'` off-cycle rows feed no exclusion set (it is `per_hour`-only), and neither `unlockPeriod` nor `calculateDraft` checks whether a catch-up already pays hours from the period being recalculated. The JSDoc says "remove the catch-up item first in that case" — nothing enforces or surfaces it.

**Scenario:** FT worker, ₱20,000, 88h expected. Jun 1–15 locks with 80h paid (₱18,182). 8h approved late → catch-up added on Jul 1–15 for ₱1,818, correctly. Later, unlock Jun 1–15 for a rate fix and recalc: gross rebuilds from 88h → ₱20,000. The ₱1,818 still stands → 8h paid twice.

**Fix:** In `unlockPeriod`, look up `off_cycle_pay_items` with `basis='salaried_hours' AND work_date = period_end` and block/warn with the item list.

### RP-13 — CSV import in the default Overwrite mode zero-fills every date and un-approves decided days

**Where:** `src/components/time/CsvImportCard.tsx:133–141, 60` · `src/server/actions/time.ts:316–329` · `src/db/queries/time.ts:104–107`

The client emits a row for every (member, date) in the CSV range **including zero-second days**; upsert mode fully overwrites — tracked seconds replaced, PTO wiped to 0, approval reset to pending. The decided-day invariant exists **only** in the Hubstaff API transform (`transform.ts:309`); the CSV path bypasses it.

**Scenario:** API sync stored Jul 4 as 0h tracked + 8h PTO; you approved it. You later upload a Jul 1–15 CSV (no per-day PTO column) in the default mode. Jul 4 becomes 0/0/pending. Approve as-is → 8h PTO underpaid.

**Fix:** Drop `trackedSeconds === 0` rows, and exclude decided `(source_name, work_date)` keys from the upsert in both modes (reuse the `fetchExistingDecided` pattern).

### RP-14 — "Add hours" replaces the day instead of adding to it

**Where:** `src/server/actions/time.ts:135–147, 185–199` · `src/db/queries/time.ts:104–107`

Both manual paths upsert on `(company_id, source_name, work_date)` with `pto_seconds: 0` and `approval: 'pending'`. If an entry exists for that day — very likely, since total mode always targets `periodStart` — existing hours are replaced, PTO wiped, an approval reverted, and `client_company_id` overwritten. The UI says "Add".

**Scenario:** Hubstaff synced 5h on Jul 1, approved. You "add" a 10h period total → Jul 1 becomes 10h pending, not 15h; approval and PTO gone, silently.

**Fix:** Read existing rows for the target keys first; sum into `tracked_seconds`, preserve `pto_seconds`, refuse or confirm when the day is already decided.

### RP-15 — In "show all unpaid" mode, editing a total moves hours across pay periods

**Where:** `src/components/time/TimeApprovalTable.tsx:125–157` · `src/server/actions/time.ts:236–241` · fed by `time/page.tsx:56–58`, `TimeShell.tsx:189–201`

Unpaid mode aggregates entries from several periods into one row, but the ✎ edit writes the whole total onto the **first** entry's date and zeroes the rest. The server never checks the ids fall within `periodStart..periodEnd` — it only logs those strings.

**Scenario:** Rows span Jun 20 (2h, open older period) and Jul 8 (6h, arrears period). Open the 8.00 total and confirm it unchanged → all 8h land on Jun 20. Jul 1–15 now calculates zero hours; June owes 8h it already closed.

**Fix:** Hide edit/add controls when `coverageHidden`; server-side reject `editContractorTotal` when any fetched entry's `work_date` is outside the period.

### RP-16 — Hourly time approved after a lock disappears from every "unpaid" surface

**Where:** `src/db/queries/time.ts:66–84` · `src/server/actions/time.ts:51–84` · `src/server/payroll.ts:315–320`

`fetchUnpaidEntries` assumes approved-inside-a-locked-period means paid. But the nightly sync can insert *new pending rows* into a locked window (the decided-day guard only protects rows that already exist), and approval is not blocked by lock. Salaried leftovers are rescued by `OffCycleCatchUpCard`; per-hour (PH / PHS-hourly) workers have no equivalent.

**Scenario:** Jul 1–15 locks on the morning of the 16th. That night's 3-day-lookback cron adds a Jul 15 correction as pending. You approve it → it vanishes from the unpaid view, is never paid, and the header reports all clear.

**Fix:** Treat an approved entry inside a locked/paid period as unpaid unless `approved_at <= locked_at` (both are stored — F8 exists for this), or extend the catch-up card to per-hour workers.

### RP-17 — Deleting a statement has no confirmation at all **[verified]**

**Where:** `src/components/payroll/PayrollShell.tsx:1325` → handler at `:550–567`

The row Delete button calls the handler directly. One click destroys the statement **and cascades**: its off-cycle ledger rows are deleted and their sessions un-marked (`payroll.ts:611–655`). Manual overrides and misc items are unrecoverable — recalc rebuilds engine values only. Delete-*all* requires typing DELETE.

**Fix:** Route through the existing `ConfirmDangerModal`, naming the contractor and the session release. No typed word needed.

### RP-18 — The inactive-contractor warning is dead code, and lock's acknowledgement was never built **[verified]**

**Where:** `src/components/payroll/PayrollShell.tsx:110`, `1121–1141` · `src/db/queries/payroll.ts:807–832` · `src/server/actions/payroll.ts:343–421`

`toEditableRow` hardcodes `inactive: false`, so the strike-through row and 🚫 badge can never render. `buildStatements` computes the flag (`mappers.ts:250–252`, tested at `mappers.test.ts:165`) but the shell renders from `fetchSavedPayments`, which drops it. Separately, `lockPeriod` never reads its `confirmed` input despite the schema comment claiming the caller has acknowledged inactive / no-method warnings.

**Scenario:** A terminated contractor's row looks entirely normal and locks and pays without a word. Rows with no payout method get a yellow select but nothing blocks lock.

**Fix:** Join worker/link status into `fetchSavedPayments` and map it in `toEditableRow`; have `lockPeriod` return the offending names unless `confirmed = true` — the field already exists.

### RP-19 — A failed payment fetch renders as an empty, successful-looking pay list

**Where:** `src/app/(admin)/process/page.tsx:55` · `src/components/process/ProcessPay.tsx:65–68`

`initialPayments={res.ok ? res.data.payments : []}`. A transient DB/RLS error shows "No contractors in this view — switch the channel filter above" for a real locked batch. After mark-paid, a failed `refresh()` silently leaves a stale table.

**Fix:** Render an explicit error state when `!res.ok`; notify on failed refresh.

---

## Medium

### Calculate

**RP-20 — Single-worker rebuild hardcodes HA on / 13th off.** `src/server/payroll.ts:257–258` (`includeHealthAllowance: !offCycleOnly, includeThirteenth: false`), called from `payroll.ts:1201, 1430, 1760`. The batch's calculate options are never persisted, so adding/removing an off-cycle item rebuilds the row under different toggles than the batch used — and resets that worker's manual misc/bonus/PDD/gross-override (documented in JSDoc, never surfaced). *Fix:* persist `include_ha`/`include_13` on `pay_periods`; use the existing unused `setPaymentOffCycle` helper (`queries/payroll.ts:487–498`) to update only `off_cycle_php` + `net_php`.

**RP-21 — Clearing the 13th-month field saves ₱0 while the modal previews "computed ₱X".** `PayrollShell.tsx:607` (`t13Php: payload.t13Php ?? 0`) drops the modal's contract that `null` means revert-to-computed (`MiscModal.tsx:106,151,183`). Row has t13 ₱9,583; you clear the field to go back to computed (label says `computed: ₱9,583.00`); net silently drops ₱9,583. *Fix:* `t13Php: payload.t13Php ?? row.computedT13Php`.

**RP-22 — Lock has no guard for approved-but-unpaid in-window sessions.** `payroll.ts:377–391` blocks pending `time_entries` only. A per-session worker's approved, unpaid session dated in-window that lands *after* the last Calculate is neither in the draft nor blocked at lock. The OffCycleModal "Add session" pane creates pre-approved sessions, making this one click away. Recoverable (it stays in the pickers) but the run underpays silently. *Fix:* count approved `service_sessions` with `paid_at IS NULL` in-window exceeding the draft's captured units; refuse like the pending-time check.

**RP-23 — `restorePaymentsSnapshot` trusts client-supplied rows verbatim.** `payroll.ts:231–235` · `queries/payroll.ts:748–765` · `RestoreSnapshotSchema` is `z.array(z.record(z.string(), z.unknown()))`. Only `company_id`/`pay_period_id` are forced; every money column, `status` and `paid_at` insert as sent — bypassing server-side net recomposition and the positive-gross rule. *Fix:* store snapshots server-side at recalc time and restore by reference, or Zod-validate and force `status='draft', paid_at=null`.

**RP-24 — The "has manual adjustments" check omits a manually set 13th month.** `PayrollShell.tsx:317–320` checks `overridden || haPhp || pddPhp || bonusPhp || miscItems.length` but not `t13Php`. Batch calculated with 13th unchecked; you set t13 ₱9,583 via Misc on one row (your only adjustment); pressing Calculate again skips the typed-RECALCULATE confirm entirely and wipes it. *Fix:* add `|| r.t13Php !== r.computedT13Php`.

**RP-25 — /payroll can land on the in-progress period rather than the arrears one.** *(suspected)* `payroll/page.tsx:49–56`; summaries ordered `period_start DESC` (`queries/payroll.ts:871`), so `find(p => p.state === 'open' && p.contractorCount > 0)` picks the **newest** open draft. The legacy sibling app seeds new periods with cloned rows on the shared DB (acknowledged at `payroll.ts:296–306`), making `contractorCount > 0` with no admin action. On Mar 22, with Mar 1–15 still open and Mar 16–31 seeded, /payroll opens on 16–31 while /time correctly defaults to 1–15. **Could not verify** whether the legacy app seeds before the prior period is locked. *Fix:* prefer the open draft matching `previousPeriod(today)`; fall back to newest.

**RP-66 — `calculateDraft` trusts a client-supplied `payDate`.** `src/types/schemas/payroll.ts:51–66` canonicalizes `periodStart`/`periodEnd` but not `payDate`; `server/payroll.ts:95–101` stores it verbatim, and `PayrollShell.tsx:249` re-adopts whatever the DB holds, so a bad value round-trips. A caller posting `payDate: '2026-12-25'` for Mar 1–15 passes validation. *Fix:* ignore the client field; derive from `periodFor(input.periodStart).payDate`. Also makes RP-03 moot at lock time.

### Time & Approval

**RP-36 — Hubstaff divergences on frozen days reach the audit log only.** `hubstaff-sync.ts:134–142` returns `rowsWritten`/`membersSeen`/`unmatched` but omits `summary.divergences` and `skippedDecided` (`service.ts:219–230`). Docs (`hubstaff.md:54–59`) promise the admin is told. An approved Jul 10 changing 4h → 8h in Hubstaff is correctly protected, logged, and invisible — toast says "Synced 0 entries". *Fix:* include `divergences.length` in the result and render a warning.

**RP-37 — Unmatched Hubstaff members are never persisted.** `lib/hubstaff/transform.ts:277–280` — unmatched users `continue` with no row emitted, contradicting `docs/pay-pipeline.md:65–66`. Their hours exist only in the sync toast and audit log; the `/time` unmatched banner only reflects names already in the DB (CSV/manual). A new hire tracked before their profile existed leaves no trace once the toast is dismissed. *Fix:* persist with `worker_id = null` (schema supports it; the calc-time matcher would then pick them up), or persist an unmatched-sync record.

**RP-38 — CSV re-import after a Hubstaff rename double-counts.** `CsvImportCard.tsx:134` sends `sourceName: m.name` raw; the API path canonicalizes via `queries/hubstaff.ts:78–101` + `transform.ts:296` precisely so a rename hits the same upsert key. Rows exist as "Ma. Cristina Cruz" (approved); the name is edited in Hubstaff; you re-import the CSV → new rows insert under the new name for the same dates, both name-match to the same worker, `attributeTimeEntries` sums both. *Fix:* canonicalize `source_name` per matched worker via `fetchCanonicalSourceNames` before upserting.

**RP-39 — Duplicate-name attribution is first-wins with no ambiguity detection.** `lib/time/attribution.ts:46–47` (`if (sk && !byName.has(sk))`), same in `transform.ts:154–155`. Diacritics/case/order are handled (`lib/names.ts:22–48`); genuine duplicates are not. Maria A. Santos and Maria L. Santos share the loose key "maria santos"; a row for "Maria Santos" resolves to whichever was indexed first, unflagged. *Fix:* record colliding keys while indexing; return "ambiguous" and surface those rows in the needs-attention banner.

**RP-40 — No server-side sanity bounds on manual hours.** `types/schemas/time.ts:26` (`hours: z.number().positive()` — no max, no `.finite()`), `:40–43`, `:56`; no ≤24h/day or date-in-period check in `actions/time.ts:120–259`. A typo of 800 for 80 is accepted and pays 10× after approval. *Fix:* `.finite().max(24)` per day, `.max(200)` for totals, reject daily dates outside the entry's own period.

**RP-41 — Period navigation gives no feedback.** `TimeShell.tsx:57` discards `isPending` from `useTransition`; `PeriodPicker.tsx:14` has a `disabled` prop that is never passed. `loading.tsx` covers only initial navigation, so `router.push('?start=…')` keeps the old UI. On a slow connection a double-click on Prev lands two periods back — you approve the wrong period. *Fix:* keep `isPending`, pass it to the picker.

**RP-42 — "All clear" dead-ends and also shows for an empty period.** `TimeShell.tsx:181–184`; no `href` exists anywhere in `src/components/time/*.tsx`. `pendingCount === 0` renders "all clear" even with **zero entries** — actively misleading before a sync — and when genuinely all-approved there is no route onward to Calculate. *Fix:* distinguish "no entries yet" from "all approved"; link to `/payroll` for the period.

**RP-43 — Approval table at scale.** `TimeApprovalTable.tsx:242` sorts by name only; `:63` uses a single shared `pendingTx` that disables every button on any action. With 100+ contractors there is no filter, no status sort, no search, and no per-row busy state, so after a partial pass it is not obvious which rows still block payroll. *Fix:* "only pending" toggle, sort decided below pending, scope busy state per row.

**RP-44 — Edit-total has no confirmation and no undo.** `TimeApprovalTable.tsx:125–157`. It silently destroys the per-day breakdown (total onto day 1, zeros elsewhere). Approvals get an undo toast (`:72–109`); `updateTrackedSeconds` snapshots nothing. Reject/Reject-all are single-click but *do* have undo, which is adequate. *Fix:* confirm with "replaces the daily breakdown (Xd) with a single first-day entry"; snapshot prior seconds for the same undo pattern.

### Process and Pay

**RP-52 — Money actions have no period-state gate server-side.** `actions/payroll.ts:725–764, 766–800, 802–842`; `actions/wise.ts:73–143` (service client). "Paying requires locked" is enforced only by `process/page.tsx:42`; migration 18 deliberately leaves `status`/`paid_at`/wise columns editable in any state. Server actions are HTTP endpoints — `markPaid` with open-period ids flips rows to `sent` mid-calculation; `wiseBatch` drafts real transfers for amounts recalc will change. *Fix:* resolve the rows' periods and require `locked` (or `paid` for re-marks).

**RP-53 — `markUnpaid` can reverse a Wise-locked, actually-sent payment — and has no UI.** `actions/payroll.ts:766–800`; `payments_lock_enforce` (baseline migration `:443–481`) doesn't protect `status`/`paid_at`. Unlike `markAllUnpaid` (which excludes `wise_transfer_id` rows at `:821–824`), per-row `markUnpaid` has no filter and no `wise_locked_at` check — and zero callers in `src/`, so the "reverse individually" path the UI promises doesn't exist. *Fix:* refuse when `wise_locked_at` is set, or delete the action until it's wired up.

**RP-54 — Wise batch amount/recipient overrides are unvalidated and unlogged.** `types/schemas/wise.ts:24–28` · `lib/wise/draft-row.ts:13–19` · `wise/service.ts:250`; audit logs only `{batchGroupId, count, drafted}` (`actions/wise.ts:121–129`). The client may send any positive `recipientId` and `amountPhp`; the server never checks the recipient belongs to that worker, and the drafted amount is recorded nowhere while `net_php` keeps the original. A ₱48,000 → ₱84,000 typo leaves no trace and later defeats amount-based matching. *Fix:* log per-row `{paymentId, amountPhp, recipientId, netPhp}`; reject a `recipientId` not in the worker's own recipients.

**RP-55 — Nothing prevents two workers sharing one Wise recipient.** `actions/wise-recipients.ts:89–120` has no cross-worker check, and no unique index exists on `workers.wise_recipient_id`/`wise_recipient_uuid` in any migration. Both nets then pay to one bank account, and the shortchanged worker's payment still "reconciles" (matcher matches by recipient + amount). *Fix:* partial unique indexes on both columns plus a pre-check.

**RP-56 — Payee-identity writes are any-admin while drafting is owner-only.** All writes in `actions/wise-recipients.ts` use `requireAdmin` + service client with no company scoping, while `wiseDraft`/`wiseBatch` are `requireOwner`. `wisePullRecipientIds` (`actions/wise.ts:341–352`) writes name-matches immediately on a bare normalized-name hit (`lib/wise/recipient-match.ts:68–72`). Changing *where money goes* is gated less strictly than creating a draft. *Fix:* owner-gate the recipient writes; require explicit confirmation for name-match auto-linking.

**RP-57 — Status pills bypass `status-pills.ts`.** `ProcessPay.tsx:393–399` hardcodes `sent → paid, else → pending`; `lib/payroll/status-pills.ts` is imported only by `PayrollShell.tsx`. `reconciled` (money confirmed) and `failed` both render as neutral "pending" with an active Mark paid button — a pill claiming "pending" when money has moved, and a failed row invisible as a failure. The module handling all five enum states already exists. *Fix:* use `paymentStatusLabel`/`paymentStatusTone`. No test covers `status-pills.ts` either.

**RP-58 — "Mark all paid" doesn't distinguish unfunded Wise drafts.** `ProcessPay.tsx:538–547` and `:105–125`. The natural flow — create drafts, then Mark all paid — flips Wise rows to a green "paid" badge while the drafts sit unfunded. The generic "only after you've actually sent the money" warning doesn't say that N of these rows are drafts awaiting funding. (`WisePayoutsPanel` itself is exemplary here: navy "drafted" pill, "no money moves" copy.) *Fix:* count wise rows still in `draft` and say so; better, let `wisePoll` mark Wise rows paid.

**RP-59 — Double-export guard is per-browser only.** `ProcessPay.tsx:79–97, 174–183` uses a localStorage stamp (with a `ponytail:` comment naming the ceiling). The "already downloaded — risks paying the batch twice" warning never fires for a second admin, another machine, or a cleared profile — exactly the multi-actor case the guard exists for. *Fix:* the upgrade path the comment names — a DB download record shown to everyone.

**RP-04 — Wise matcher's ±7-day window cannot span the legal payment window.** `lib/wise/matcher.ts:48, 78–81, 328–337`; default `windowDays = 7` at `server/wise/service.ts:469`. Backfill anchors on `paid_at ?? pay_date ?? period_end`; for never-marked-paid rows that is `pay_date`, while the legal window is ~15 days wide. Period Mar 1–15, deadline Mar 31, transfer sent Mar 17 (legal, unmarked) → window Mar 24–Apr 7 → `no_wise_transfer_in_window`. With RP-03 the window shifts to Mar 8–22 and a Mar 30 transfer misses. **This is a spec bug**, and `tests/lib/wise/matcher.test.ts:180–193` asserts the current ±7 boundary as correct — fixing the code will fail that test by design. *Fix:* anchor at the midpoint of `[period_end, pay_date]`, or raise the default to 16.

**RP-05 — Mark-paid pre-fills the send date with the deadline.** `ProcessPay.tsx:258` (`period.payDate ?? today`). The prompt asks when the transfer actually happened. With RP-03 it back-dates; without RP-03 it pre-fills a future date. *Fix:* default to today.

---

## Low

| ID | Finding | Where |
|---|---|---|
| RP-26 | Auto-save fires on mere page load, rewriting every row's `fx_rate` and corrupting override notes; serial awaits mean N round-trips per keystroke burst | `PayrollShell.tsx:455–486` |
| RP-27 | Per-hour off-cycle exclusion drops the whole day's tracked hours instead of the item's units (unreachable from current UI — the modal filters to `per_session` — but the action/schema accept it) | `mappers.ts:120` |
| RP-28 | Misc item amounts unvalidated server-side; `{kind:'deduction', amount:-5000}` would **add** ₱5,000 | `types/schemas/payroll.ts` |
| RP-29 | No once-per-year guard on the 13th-month toggle; the accrual is stateless, so checking it on extra runs over-accrues (recalc of the same period is safe; HA is anniversary-gated) | `lib/pay/calc.ts:187–193` |
| RP-30 | Confirm-modal wording drifts from behavior: recalculate says "allowances reset to 0" (they're recomputed); unlock omits Misc items; lock omits the pay_date write; "Re-lock batch" is a guaranteed error toast since the server refuses `state !== 'open'` | `PayrollShell.tsx:330, 891, 1469` |
| RP-31 | Undo-recalculation button survives period switches (restores the snapshot's period while you look at another) and evaporates on refresh — client memory only | `PayrollShell.tsx:168–171, 1018–1028` |
| RP-32 | Per-session rows read as broken — Worked 0.00 / Exp 0 / Ratio 0% — and `units` isn't even selected into `SavedPayment`, so the gross is unverifiable from the table | `PayrollShell.tsx:1143–1145`, `queries/payroll.ts:1273` |
| RP-33 | FX field can't be cleared (`parseFloat(v) \|\| DEFAULT_FX` snaps empty to 58, and "0." is untypable) and is in the save-effect deps, so each change rewrites every row | `PayrollShell.tsx:987, 486` |
| RP-34 | Off-cycle batch lock blocked by today's unrelated pending time (batch window is `today–today`), with a message telling you to recalculate something the UI can't recalculate | `actions/payroll.ts:380–391` |
| RP-35 | Salaried mid-period rate change back-prices the whole period — spec-intended (money-core §5; per-unit workers got the date-aware split, salaried deliberately didn't) but the Rate column gives no hint | `lib/pay/rates.ts:31–46` |
| RP-45 | Approval/undo/edit writes are id-scoped, not company-scoped; RLS blocks cross-tenant, but a multi-company admin can pass company A with company B's ids and the audit log misattributes | `queries/time.ts:131–147, 150–183, 186–197` |
| RP-46 | CSV import trusts the client's `workerId` mapping (contrast `importSessions`' server-side re-check at `actions/sessions.ts:216–224`); `matchedMembers` includes inactive while `matchedCount` excludes them, so an all-inactive parse leaves the button disabled | `actions/time.ts:316–329`, `CsvImportCard.tsx:126, 166` |
| RP-47 | Off-cycle catch-up card never refreshes after approvals — it documents a `refreshKey` the parent never passes, and `router.refresh()` doesn't re-run the client effect | `OffCycleCatchUpCard.tsx:29–50`, `TimeShell.tsx:133` |
| RP-48 | Swallowed errors render as healthy empty states: client-list failure → "no client"; recent-sessions failure → "No sessions waiting"; no `FileReader.onerror`; no route-level `error.tsx` anywhere in `src/app/` | `AddUnlistedRow.tsx:67–71`, `AddSessionForm.tsx:204–213`, `CsvImportCard.tsx:71–94` |
| RP-49 | A11y: edit-total input has no label/aria-label; ✎ button named by `title` only; `colSpan={9}` even when the unpaid view renders 7 columns; CSV preview table lacks `data-label`s so mobile card mode shows bare values | `TimeApprovalTable.tsx:295–306, 334–347`, `AddUnlistedRow.tsx:145` |
| RP-50 | "Add as contractor" hardcodes `contract: 'FT'` with a guessed name split — a per-session therapist is then priced on the salaried ratio model | `CsvImportCard.tsx:101–107` |
| RP-51 | Leaving "all unpaid" mode discards the picked period (`router.push(unpaidMode ? pathname : '?unpaid=1')` drops `?start`) | `TimeShell.tsx:82–84` |
| RP-60 | Zero-net rows lock and export as amount `0`; the API path skips `<= 0` but the manual CSV writes them, and Wise rejects the row (possibly the whole upload) | `actions/payroll.ts:395`, `wise-batch.ts:68` vs `wise/service.ts:179–186` |
| RP-61 | `markPaid` reports the requested count, not the actual updated count — the toast and audit log echo `input.paymentIds.length` even if RLS filtered rows | `actions/payroll.ts:744, 757` |
| RP-62 | CSV builders don't neutralize spreadsheet formula injection: a name starting `=`, `+`, `-`, `@` executes as a formula in Excel. Wise's importer is unaffected; the individual/record-keeping file is routinely opened in Excel | `wise-batch.ts:43`, `bank-export.ts:18–23`, `individual-payments.ts:18` |
| RP-63 | "Mark all unpaid" modal promises per-row reversal ("must be reversed individually") that has no UI caller | `ProcessPay.tsx:548–556` |
| RP-64 | Per-row mark-paid date entry is a raw `window.prompt` with regex validation — no calendar, easy to fat-finger a month (it does correctly support any date, honoring the flexible pay rule) | `ProcessPay.tsx:255–269` |
| RP-65 | Displayed Wise total (sums all wise rows) can differ from the file total (UUID-resolved rows only), and the download card never states the file's own sum to reconcile against Wise's preview | `ProcessPay.tsx:50–51, 286–300` vs `wise-batch.ts:68` |
| RP-67 | Off-cycle batch is dated with UTC "today", so a New York admin working after ~8 PM creates a batch labeled tomorrow. Label-only — the window intentionally captures no hours/sessions | `actions/payroll.ts:1668, 1702` |

---

## Verified correct

Worth stating plainly, because it locates the risk: **the pure calculation engine is sound.** Nearly every defect above lives in the orchestration layer wrapped around it.

- **Rounding and money units.** Integer centavos end to end; exactly one rounding per money product (`mulRatioMinor`, half-away-from-zero); `centavosToPhp`/`phpToCentavos` round-trip exactly at 2 dp; net summed in centavos and converted once — no sum-of-rounded drift. Wise and individual CSV amounts match stored `net_php` to the centavo.
- **Pay models.** Salaried cap at rate (no overtime premium), `expected = 0` guard (positive work → full rate, no work → 0; no division by zero), PHS `pay_basis = null` → `unset` → null gross, unpayable and blocked from lock. Per-unit 13th correctly suppressed. Covered by `tests/lib/pay/calc.test.ts` plus real-data parity fixtures.
- **`deduction_php` is informational.** Never subtracted (`calc.ts:114`, `row-net.ts`, `updatePaymentRowAction`); the payslip renders it in a muted box saying "not deducted from your pay". Misc `kind:'deduction'` subtracts, everything else adds — tested.
- **Allowances.** HA pays once, anniversary-period only, 180-day gate, day clamped to 28; a zero-time row is built so the ₱20k can't be lost; recalculation recomputes rather than accumulates; one row per (period, worker) via upsert conflict key.
- **The holiday fix (`fd79444`) is complete.** `workingDayCount` is the single denominator source (`expected-hours.ts:61–79`); calculate, single-worker recompute and catch-up all pass the same `resolveHolidaysForRange`; weekend observance and cross-year shift handled. **Caveat: see prior finding #025 — the default holiday *set* is US federal.**
- **Period math.** `periodFor` and `previousPeriod` correct on both halves, Dec→Jan rollover, leap February, 31-day months; UTC ISO-string math throughout, DST-proof. `isDateInAnyPeriod`/`periodDates`/`weekdayCount` all pure and correctly consumed.
- **Session routing (post-`eb760ad`).** Sessions route to the period whose window *contains* their date, with locked-period refusal and mixed-resolution rejection; statement delete frees sessions and their ledger rows; DB partial-unique indexes back it up.
- **Lock guards.** Null-net and negative-net rows blocked; pending time blocked; locked/paid periods refuse recalc/edit/off-cycle changes in both the action and the DB trigger (`payments_period_open_enforce`), so a post-lock edit is impossible even via a raced request.
- **Flexible processing window respected.** No date-based gate anywhere; `markPaid` accepts any `paidAt`; the Wise poll uses the real sent date.
- **Draft-only payouts.** No funding call exists; `scripts/guardrails.mjs` scans for one; UI copy is unmistakable.
- **Auth.** Every action re-verifies via `getCurrentAdmin`/`requireAdmin`/`requireOwner`; Wise drafting is owner-only; `payments_admin_all` RLS company-scopes non-owner admins, blocking cross-tenant marking at the DB.
- **A11y / responsive.** Native `<dialog>` modals (focus trap, Escape, focus restore), labeled inputs, `aria-sort`/`aria-expanded` where expected, no-rate conveyed by text as well as color, wide tables scrolling in their own containers with `data-label` card mode under 768px.

---

## Why 522 green tests missed all of this

The pattern is unambiguous once findings are laid over the coverage map.

**Well covered (and correspondingly clean):** `calc`, `rates`, `holidays`, `periods`, `allowances`, `expected-hours`, `catch-up`, `wise-batch`, `bank-export`, `row-net`, `mappers`, `carried-over`, `individual-payments`, `attribution`, `hubstaff/transform`.

**No coverage at all:** `src/server/actions/payroll.ts` (1,783 lines, no dedicated test file) — and specifically:

- `lockPeriod`'s guard set **and its `pay_date` argument** — one assertion would have caught RP-03 the day it shipped
- `markPaid` / `markUnpaid` / `markAllUnpaid` / `toggleWiseRowLock`, `syncPeriodPaidState`, `stepPeriodToLocked`
- `serviceDraft` / `serviceBatch`, including the double-draft and override paths
- `restorePaymentsSnapshot`, `recomputeWorkerDraft`, `shouldAutoRecalcDraft` (the pure `isCarriedOverClone` is tested; the action isn't)
- `updatePaymentRowAction`'s net recomposition and the override/note lifecycle
- `importCsvBatch` upsert semantics, `addHoursTotal`/`addHoursDaily`, `editContractorTotal`
- `updateApproval` timing stamps and `restoreApprovals`
- `status-pills.ts`; `MiscItemSchema` bounds; `buildWiseBatch` with a non-PHP target
- `fetchUnpaidEntries`' locked-period filter — exercised only by `e2e/time-review.e2e.mjs`, which never runs in CI

**Every critical and high finding sits in that untested layer.**

---

## Suggested order

1. **RP-02** — one-line guard, removes a 58× overpay path.
2. **RP-01** — the live double-pay route; needs care (stamp on lock, clear on unlock).
3. **RP-03** — one-line fix, unblocks correct Wise reconciliation. Closes prior #028.
4. **RP-11** — confirm the prod `max_rows` first; silent underpay if it bites.
5. **RP-06 / RP-07** — the screen-vs-DB divergence pair on Calculate.
6. **RP-08 / RP-09 / RP-10** — the Wise/mark-paid integrity set.
7. **RP-04** — after RP-03, since the correct anchor changes the window design.
8. Then the Time & Approval highs (RP-13 → RP-16), which corrupt input rather than output.

Add a test alongside each; the layer has none, which is why these shipped.
