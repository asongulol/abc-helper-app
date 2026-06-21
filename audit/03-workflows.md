# Audit 03 — Workflows & Algorithm Correctness (Track 3)

Read-only audit of **abc-helper-app** (Next.js 16 App Router payroll system). Scope: end-to-end workflow traces (Part A) and business-logic algorithm correctness (Part B). Every claim is cited `file:line` or `table.column`. Labels: **OBSERVED** (read in code), **INFERRED** (reasoned from code), **ASSUMPTION** (ambiguity flagged).

Money is integer **centavos** (PHP) / **cents** (USD), branded types, never floats (`src/lib/money/index.ts:16-23`). Spec anchor: `docs/money-core-spec.md`.

---

## §1 — Workflow Traces (Part A)

### Flow 1 — Time ingestion → approval

```
Hubstaff API (Option B) ─┐
  list_orgs / sync        ├─► time_entries (approval='pending') ─► attribution ─► TimeApprovalTable ─► approve/reject
CSV import ──────────────┤        (worker_id or source_name)        (lib/time/attribution.ts)   (server/actions/time.ts)
Manual hours add ────────┘
```

**Happy path (OBSERVED)**
1. **List orgs** — `listHubstaffOrgs()` reuses the read-only Hubstaff client `getAccessToken`/`pageAll` to GET `/organizations`, populating the dropdown (`src/server/actions/hubstaff-sync.ts:43-66`).
2. **Sync (Option B default)** — `importHubstaffTime()` Zod-validates company/org/start/stop, re-verifies admin + company scope, then delegates to `syncHubstaffForCompany` via the **service client** (`src/server/actions/hubstaff-sync.ts:94-149`).
3. **Pull/transform** — the pure transform accumulates daily activities (`accumulateActivities`, `src/lib/hubstaff/transform.ts:46-72`), merges approved PTO (`accumulatePto`, `:82-113`), matches users id→strict-name→loose-name (`matchWorker`, `:166-177`), resolves a canonical `source_name` so upserts hit the same unique key (`resolveSourceName`, `:219-226`), and emits `time_entries` rows with `approval:'pending'` + `import_batch_id` (`transformActivities`, `:242-322`).
4. **Decided-row guard** — rows a human already approved/rejected are never overwritten by sync (`buildDecidedSets` + the skip at `:292-297`). **This is the "never silently clobber a decision" invariant.**
5. **CSV import** — `importCsvBatch()` upserts parsed rows (`upsert`/`skip` modes); skip-mode pre-fetches existing `(source_name, work_date)` keys and drops dupes (`src/server/actions/time.ts:261-345`).
6. **Manual hours** — `addHoursTotal` (whole period total on the first day), `addHoursDaily` (per-day, only `hours>0`), `editContractorTotal` (rewrite total onto first entry, zero the rest) (`src/server/actions/time.ts:119-256`).
7. **Attribution** — at calc time, `attributeTimeEntries` resolves each entry: `worker_id` direct, else by `source_name` (exact then `nameKey`-normalized) (`src/lib/payroll/mappers.ts:70-120`). Unresolved names → `unattributed[]`; workers with time but no company link → `unlinkedWorkerIds[]`. **Nothing is dropped silently** (`:97-104`, surfaced via `CalculateDraftResult`, `src/server/payroll.ts:38-39,112-113`).
8. **Approval** — `setTimeApproval()` snapshots prior approval BEFORE the update (for undo), then flips status (`src/server/actions/time.ts:50-83`); `undoApproval()` restores from the snapshot (`:86-114`). Undo payload built by `buildUndoPayload` (`src/lib/time/approvalUndo.ts`).
9. **Batch delete** — `deleteImportBatch()` blocks if any entry's date falls in a locked/paid period (`src/server/actions/time.ts:382-389`), then cleans up empty open-period drafts (`:394`).

**Friction / dead-ends / waste**
- **Vendored-copy drift (real maintenance hazard).** The deployed Deno edge fn `supabase/functions/hubstaff-sync/index.ts` cannot import `src/`, so the entire transform is hand-copied (`index.ts:148-383`) and kept in sync manually + by `tests/lib/hubstaff/vendored-parity.test.ts`. (subagent-confirmed; OBSERVED via test file presence.)
- **Two attribution name-match implementations.** `lib/time/attribution.ts` (`buildMatchIndex`/`matchName`, strict→loose, with `isInactive`) and `lib/payroll/mappers.ts:74-83` (`idByName` map, exact→`nameKey`) both resolve source names but differ: mappers does **not** use the loose key and does not track inactive. INFERRED divergence — calc-time attribution is the weaker matcher (no loose fallback).
- **`activity_pct` from CSV vs sync diverge** — sync computes `round(overall/tracked*100)` (`transform.ts:300`), CSV trusts the file's `activityPct` (`time.ts:320`); manual adds set it `null`. Cosmetic.
- **No dead end** in the happy path, but a row matched only by **name** with no `hubstaff_user_id` stored is queued to backfill the id (`transform.ts:273-281`) — good, prevents future dupes.

**Error/edge handling** — every action returns `{ok:false,error}` (no throws to client); Zod first-issue surfaced; org/sync failures append a "is the function deployed / token set?" hint (`hubstaff-sync.ts:60-65,142-148`).

---

### Flow 2 — Calculate → review → lock → pay

```
/calculate ─► calculatePeriodDraft ─► calculateDraft (fetch→compute→persist) ─► payments(status='draft'), pay_period(state='open')
                                          │ buildStatements → calcContractorRow (pure)
/batches ──► PayrollShell ─► editable rows (updatePaymentRowAction) ─► lockPeriod(open→locked) ─► /process markPaid(status='sent')
```

**Happy path (OBSERVED)**
1. **Calculate draft** — `calculatePeriodDraft()` (admin + scope + Zod) → `calculateDraft()` (`src/server/actions/payroll.ts:122-149`).
2. **Refuse non-open** — `calculateDraft` throws if the period exists and is not `open` (`src/server/payroll.ts:51-54`).
3. **Fetch in parallel** — approved time, roster, rates, last-payout-methods (`src/server/payroll.ts:56-61`); PS session units fetched via the **service client** because `service_sessions` belong to client companies invisible to an employer-scoped admin under RLS (`:69-74`, justified `:64-68`).
4. **Compute** — `attributeTimeEntries` then `buildStatements` runs one `calcContractorRow` pass per attributed worker, plus a PS-only second pass that pulls in per-session workers with no tracked time (`src/lib/payroll/mappers.ts:151-204`).
5. **Persist** — `upsertOpenPeriod` (creates/keeps `state:'open'`, `src/db/queries/payroll.ts:174`), then `upsertDraftPayments`. Rows with `net===null` (no rate) are filtered out before persistence (`src/server/payroll.ts:97-100`; `toPaymentDraft` returns null on null net/gross, `mappers.ts:238`). Returns `unattributed`, `unlinkedWorkerIds`, `skippedNoRate` warnings (`:109-115`).
6. **Review / edit (hours-override + misc)** — `updatePaymentRowAction()` verifies the period is `open` (`payroll.ts:354`), recomputes net server-side in centavos with the same composition as the engine (`gross+ha+t13+pdd+bonus+misc`, `:386-388`), and on a gross override writes a note recording the computed gross (`:391-399`). Misc items via `components/payroll/MiscModal.tsx` flow through `miscItems` into `miscTotal` (`:386`). Client-side mirror: `recomputeNetCentavos` (`src/lib/payroll/row-net.ts:30-39`) — same formula.
7. **Lock (open→locked)** — `lockPeriod()` re-finds the period, requires `state==='open'` (`payroll.ts:225`), **blocks if any payment has null net** (no rate) and returns the names (`:228-235`), then `dbLockPeriod` sets `state:'locked'` + `locked_at` (`db/queries/payroll.ts:292-296`).
8. **Pay (/process)** — `markPaid()` sets payments `status:'sent', paid_at` (`payroll.ts:530-567`; query `markPaymentsPaid`, `db/queries/payroll.ts:423-434`).
9. **Reverse** — `unlockPeriod()` (refuses `paid`, requires `locked`, `:280-286`); `markAllUnpaid()` reverses only non-Wise sent rows and steps the period back to `locked` (`payroll.ts:603-643`).

**Friction / dead-ends / waste**
- **DEAD END / BUG: the `paid` period state is never written.** The enum has `open|locked|paid` (`supabase/migrations/00000000000001_baseline_abc_schema.sql:126-133`) and the UI maps it (`src/lib/payroll/status-pills.ts:8-18`), but **no code path sets `state:'paid'`** — repo-wide grep for `state: 'paid'` returns zero hits (OBSERVED). `markPaid` only flips *payment* status to `'sent'`; the period stays `'locked'` forever. So the documented `open→locked→paid` machine is really `open→locked` for the period, with paid-ness tracked only at the payment row. The overview/`PayrollShell` "paid" displays (`overview/page.tsx:46`, `PayrollShell.tsx:427`) are effectively unreachable for `pay_periods`. **(Spec §9 says states are open→locked→paid — divergence.)**
- **Recalculate is destructive.** `calculateDraft` discards manual overrides/adjustments on re-run; the warning + undo snapshot is owned by the UI, not the service (`src/server/payroll.ts:44-47`) — if a caller bypasses the UI, edits are silently lost. INFERRED risk.
- **`markAllUnpaid` cannot reverse Wise rows.** It filters to `!wiseTransferId` (`payroll.ts:623-625`); Wise-paid rows need individual handling — by design but a friction point (no bulk path).
- **Lock does not validate payout method or inactive links** server-side; those are "confirmed=true" UI acknowledgements only (`payroll.ts:203-206` docstring) — the server trusts the client confirm.

**Error/edge** — every action re-verifies admin + company scope (ADR-0004). `deleteAllStatements` requires `state==='open'` (`payroll.ts:486-487`). Degenerate zero-expected periods handled in calc (see §2).

---

### Flow 3 — Wise payout (DRAFT-ONLY) → reconcile

```
payments(status='draft') ─► wiseDraft/wiseBatch (OWNER) ─► Wise quote + DRAFT transfer ─► wise_transfer_id back on row
                                                              (NO funding — owner funds in Wise UI)
cron ─► wise-payouts edge fn (x-cron-secret) ─► GET transfer detail ─► PATCH status='sent'  (servicePoll twin)
admin ─► wiseMatch ─► serviceMatch ─► matcher.ts (filterLive → ID-first → strict → variance) ─► applyMatchPatch
```

**Happy path (OBSERVED, service-layer subagent-confirmed)**
1. **Draft** — `wiseDraft()`/`wiseBatch()` require **OWNER** (`src/server/actions/wise.ts:73,111`), Zod-validate, then `serviceDraft`/`serviceBatch` create a Wise **quote** (`service.ts:110-118`) and a **draft transfer** (`service.ts:126-137`); batch path creates a batch-group first (`service.ts:229-235`). `wise_transfer_id` (+`fx_rate`) written back per row.
2. **Hard stop after draft** — explicit comments "No POST .../payments. Money has NOT moved." (`service.ts:142`, `:297-298`); the client wrapper has **no funding helper** by design (`src/server/wise/client.ts:11-13`).
3. **Cron reconcile** — edge fn validates `x-cron-secret` against `app_secrets.cron_secret` (`supabase/functions/wise-payouts/index.ts:220-227`), GETs each transfer (GET-only `wiseGet`, `:128-135`), and on a terminal Wise paid state PATCHes `payments` to `status:'sent', paid_at, wise_dates, wise_locked_at` (`:179-192`). On-demand twin: `wisePoll`→`servicePoll` (`service.ts:334-423`), admin-gated (`actions/wise.ts:157`).
4. **Backfill match** — `wiseMatch()` (admin) → `serviceMatch` fetches unmatched `payout_method='wise'` payments, computes a padded union window (`max(windowDays,45)`d for the API pull, tight `windowDays` for matching), `filterLive` strips cancelled ghosts, builds recipient/id indexes, then per row calls `decideRefresh` (stored id) or `decideMatch` (`service.ts:452-701`; matcher `src/lib/wise/matcher.ts`). Orphan suggestions via `annotateOrphans`.
5. **Finalize** — `/batches` `reconcileAllPending()` flips confirmed payments (`sent` + `paid_at` + (non-Wise OR Wise-with-transfer)) to `status:'reconciled'` — status-only, reversible (`src/server/actions/reconcile.ts:123-163`). `WiseReconCard.tsx` exposes "Backfill" (`wiseMatch`) and "Scan all" (`wisePoll`).

**Draft-only invariant — CONFIRMED enforced at THREE layers (OBSERVED)**
1. **By construction** — no funding code path exists anywhere in `src/` or `supabase/functions/` (subagent grep: zero functional hits for `fund*`, `/transfers/{id}/payments`, batch-group `complete`). The Wise client wrapper sends only caller-supplied method/path and has no fund helper (`client.ts:11-13`); edge `wiseGet` is GET-only.
2. **Documented hard-stops** at every draft site (`service.ts:142,214,297-298`; `wise-payouts/index.ts:23-26,182`).
3. **Build-time guardrail scanner** — `scripts/guardrails.mjs:22-25` fails the build (exit 1, file:line) on `\bfundTransfer\b|\bfundWithBalance\b|\.fund\s*\(|\/transfers\/[^'"`]*\/payments\b`, scanning roots `['src','supabase/functions']` (`:18`); runs pre-push + CI.

**Friction / dead-ends / waste**
- **Cron only polls, never matches.** A drafted-but-unlinked payment (no `wise_transfer_id`) is invisible to the cron reconcile and requires a human to click "Backfill" (`wise-payouts/index.ts` handles only `cron_reconcile`). INFERRED gap.
- **`wiseRates()` action is inert** — calls `serviceRates([])` with an empty array, so it always returns the default `{rate:1}` (`actions/wise.ts:281-284`).
- **Dead UI button** — "Check emails" rendered permanently disabled (`WiseReconCard.tsx:97-104`).
- **`serviceFindTransfersByRecipient` pulls up to 5,000 transfers then filters client-side** (`service.ts:912-927`) — no server-side `targetAccount` filter.
- **Duplicate reconcile logic** — `servicePoll` (Next) and `handleCronReconcile` (Deno) duplicate the poll loop (intentional: admin vs cron driver).

**False-match risk** — see §2 (matcher). The discovery decision is made on **list-row `created`** dates, with precise `dateSent`/`dateFunded` fetched only AFTER the winner is chosen (`service.ts:582-595`) — the which-transfer choice and the date-enrichment use different data. Mitigated by tolerance + ambiguity guards.

---

### Flow 4 — Client invoicing

```
roster (bill_rate_usd) × employer tracked time  ┐
approved client sessions (session_rate_usd)     ├─► computeInvoice (USD cents) ─► allocate_invoice_no (atomic) ─► invoices + invoice_lines
markup once on combined subtotal                ┘
```

**Happy path (OBSERVED)**
1. **Preview/Generate** — `previewInvoice`/`generateInvoice` (admin + client-scope + Zod, `from<=to` guard) → `computeForClient` (`src/server/actions/invoicing.ts:57-225`).
2. **Source data** — `fetchEmployerCompanyId` (derived, never hardcoded, `db/queries/invoicing.ts:88-89`), `fetchClientRoster` (active links + `bill_rate_usd`), `fetchEmployerTrackedSeconds` (PTO excluded — only `tracked_seconds`, `:188-211`), `fetchClientSessions` (approved sessions, rate resolved from the link **regardless of status** so deactivated links still bill, `:131-185`).
3. **Compute** — `computeInvoice` builds hourly lines (`workedHours × billRateUsd`, hours rounded 2dp first) and session lines (`count × sessionRateUsd`), drops zero-quantity lines, keeps zero-rate lines (flagged), applies markup **once** to the combined subtotal (`src/lib/invoicing/compute.ts:111-192`).
4. **Allocate number** — `allocateInvoiceNo(year)` → RPC `allocate_invoice_no` (`db/queries/invoicing.ts:282-286`).
5. **Persist** — `createInvoiceWithLines` inserts header (`status:'draft'`) + line snapshot; the `invoices_one_live_per_period` unique index error is caught and surfaced as "void it first to regenerate" (`actions/invoicing.ts:195-204`, `db/queries/invoicing.ts:288-342`).
6. **Status/void** — `setInvoiceStatus` (draft→sent→paid, or void) (`actions/invoicing.ts:228-256`).

**invoice_no atomicity (OBSERVED)** — migration `00000000000004_invoice_no_atomic.sql` replaces the count-based allocator with `pg_advisory_xact_lock(hashtext('allocate_invoice_no'), p_year)` + `max((split_part(invoice_no,'-',2))::int)+1` filtered `status<>'void'`, backed by a partial UNIQUE index on `invoice_no`. **Correct:** `max()+1` never **reuses** a number after a void (count() would have), the advisory lock serializes concurrent `generate()` calls, and the UNIQUE index is the backstop. The DO-block guards the index creation if pre-existing dupes exist.

**Friction / dead-ends / waste**
- **Regenerate requires manual void** (the one-live-per-period index) — no one-click "void & regenerate"; surfaced as an error message.
- **`fetchClientSessions`/`fetchEmployerTrackedSeconds` use `.limit(100000)`** (`db/queries/invoicing.ts:144,203`) — a silent cap, not a paginated read; large windows could truncate. INFERRED risk (low).
- **Hourly vs session attribution asymmetry** — hourly is roster-driven (employer time re-attributed via active link), session is data-driven (carries its own rate); a worker can produce both a $0 hourly line (no rate) and a session line — by design, flagged via `zeroRateNames`/`zeroSessionRateNames` (`actions/invoicing.ts:102-107`).

---

### Flow 5 — Onboarding → hire → e-sign → document review
(subagent-traced; citations OBSERVED)

```
AddContractorWizard ─► hireContractor ─► workers + link + rate + (login if invite) ─► onboarding_progress(stage1_sign)
contractor ─► sign 4 agreements (order-enforced) ─► onboarding_signatures ─► stage2_profile
profile tabs ─► stage3_docs ─► upload ─► admin reviewDocument (approve/needs-replacement/waive/defer) ─► complete
admin ─► countersignAgreement (onboarding_agreements)
```

**Happy path (OBSERVED)**
1. **Hire** — `AddContractorWizard.tsx:197-218` → `hireContractor()` (admin + scope + Zod + dup-email/dup-login/soft-dup-name checks, `src/server/actions/contractors.ts:250-332`); ordered rollback-guarded writes: worker+link → profile → engagement fields → rate (only if `ratePhp>0`, via `saveRate`) → optional client-invoicing link → portal login (`:338-441`). Best-effort prep (agreement prefill, tools, extra-docs) in a swallowed try/catch NOT rolled back (`:443-536`).
2. **E-sign (Stage 1)** — `signAgreement()` enforces signing order server-side by reading prior signed kinds (`portal.ts:421-438`), validates the signature data-URI (shape + 1MB cap), inserts with `upsert ignoreDuplicates:true` on `(worker_id, agreement_kind, doc_version)` (`portal.ts:446-462`); when all 4 signed, advances to `stage2_profile` (`:470-505`).
3. **Countersign** — `countersignAgreement()` requires `admin.canCountersign`, prior contractor signature, not-already-countersigned, and assigned-countersigner-only (`portal.ts:538-579`); upsert on `(worker_id, agreement_kind)` (`:583-597`).
4. **Stage 2/3** — profile tabs via `completeOnboardingTab`; docs uploaded then reviewed via `reviewDocument`; stage 3 recomputed after each review by `recomputeStage3` using shared `isStage3Complete` (`portal.ts:628-643`; `lib/onboarding/documents.ts:190-217`).
5. **Decision semantics** — approve (counts as evidence; NBI >6mo blocked first, `portal.ts:675-686`), needs_replacement (requires a note; stays outstanding), **waive** (clears the kind; inserts fileless placeholder), **defer** (clears the kind + due date) (`portal.ts:649-816`; `documents.ts:198-217`).

**Friction / dead-ends / waste**
- **Scroll-gate is fabricated.** `scrolled_to_end` is written literal `true` on every signature (`portal.ts:454`); the sign modal has no scroll listener and enables "Sign" on typed-name alone (`PortalOnboarding.tsx:565`). The DB column exists and is read back but is always-true noise. **Legal/compliance evidence gap.**
- **Signature ledger immutable by convention only** — UNIQUE + `ignoreDuplicates` prevents resign-overwrite, but there is **no DB trigger** blocking UPDATE/DELETE, and admin date-edit actions (`editAgreementDate`/`setSignedDate`) do mutate `signed_date` (`portal.ts:890-895`, `onboarding.ts:336-340`). Not a true append-only ledger.
- **Best-effort prep silently fails** — agreement prefill / tools / extra-docs swallow errors (`contractors.ts:534-536`); contractor created but agreements may show blank engagement lines with no surfaced error.
- **Wizard sends `extraDocs:[]` and `shiftLabel:null` always** (`AddContractorWizard.tsx:179,185`) — server-supported features effectively dead from this UI.
- **Two creation paths** — `addContractor` (quick-add, skips dup checks) vs `hireContractor` (full) (`contractors.ts:33` vs `:250`).

---

### Flow 6 — Coverage / "Needs attention" overview board
(subagent-traced; citations OBSERVED)

**Signals computed** (`src/db/queries/overview.ts` + `src/app/(admin)/overview/page.tsx`):
1. **Locked, not sent** — locked periods + their net total (`page.tsx:110-112`).
2. **Time pending approval** — `count(time_entries WHERE approval='pending')` (`overview.ts:86-94`).
3. **Contractors needing setup** — distinct workers with `no_rate` (approved time but no effective rate for the period, `overview.ts:266-308`) or `no_payout_method` (payment row with null method, `:311-337`).
4. **Docs & onboarding** — pending document reviews + onboarding rows with `completedAt==null` (`page.tsx:116-118`).
5. **Pay-cycle pipeline** — timeImported / approved / calculated / locked / paid booleans (`getPipelineData`, `overview.ts:119-189`).
6. **Net-pay sparkline + deltaPct** over last 6 locked/paid periods (`getRecentPeriodNets`, `overview.ts:205-242`).

**Friction / dead-ends / waste**
- **"Payout issues" tile is a hardcoded `0` / green / "No failed payouts"** — no query backs it (`page.tsx:243`). Always reads healthy regardless of `status='failed'` rows.
- **Document EXPIRY is NOT surfaced here.** `lib/documents/expiry.ts` feeds only the Documents admin screen + edge fn, not the overview. An expired IC/W-8BEN/NBI produces no overview signal (the "Docs" tile uses `reviewStatus='pending'` only). Coverage gap.
- **`AlertsBanner.tsx` is orphaned** (never imported) — the page computes the alert array only for a *count*, never showing the per-worker actionable detail.
- **`getPeriodCounts` is dead code** (`overview.ts:35-49`, never imported).
- **"Data-quality" card + "Refresh" are non-functional** — `<Link>`s, no real check / no revalidation (`page.tsx:168-174,250-278`).
- **No try/catch on the page `Promise.all`** — one failing query errors the whole page; `StatTile`'s `error` prop is unused so there's no per-tile degradation.

---

## §2 — Algorithm Correctness Findings (Part B)

| Algorithm | Rule | Impl ref | Spec / test ref | Finding | Severity |
|---|---|---|---|---|---|
| `periodFor` | day≤15 → [1,15], payDate=EOM same month; day≥16 → [16,EOM], payDate=15th next month (Dec→Jan) | `src/lib/dates/periods.ts:57-73` | spec §1 `docs/money-core-spec.md:18-23`; `tests/lib/dates/periods.test.ts` | **Correct.** Dec→Jan rollover handled (`:66-67`). All UTC-day math (no DST artifact). | OK |
| `periodDates`/`weekdayCount` | every ISO date inclusive; Mon–Fri count | `:76-92` | spec §2 `:25-28` | Correct; uses `getUTCDay`. | OK |
| Holiday engine | 10 observed US holidays; weekend→nearest weekday; weekend-landing still reduces expected | `src/lib/pay/holidays.ts:77-145` | spec §3 `:30-39`; `tests/lib/pay/holidays.test.ts` | **DIVERGENCE FROM SPEC (likely a legacy-bug fix).** Spec §3 says "Holidays falling Sat/Sun do NOT reduce expected" (`:49`), but `observedDate` shifts Sat→Fri / Sun→Mon so they DO still reduce expected (`holidays.ts:61-66,127-145`). Parity test asserts `expectedHours` reproduces stored values for FT/PT (`parity.test.ts:147-159`), so the live data matches the shift-observance behavior — i.e. the **spec text is stale**, the code matches production. Document, don't "fix". | Med (spec vs code mismatch) |
| `expectedHours` | dayH=4 PT / 8 FT (PH/PS→0); `max(0, weekdays*dayH − holidays*dayH)` | `src/lib/pay/expected-hours.ts:30-45` | spec §4 `:41-49` | **Correct** modulo the observance note above. PH/PS→0 day-hours is a new (post-spec) extension. | OK |
| `resolveRate` | candidates: `eff_start<=periodEnd AND (eff_end IS NULL OR eff_end>=periodStart)`; latest `eff_start` wins; string ISO compare | `src/lib/pay/rates.ts:25-40` | spec §5 `:51-61`; `tests/lib/pay/calc.test.ts:216-256` | **Correct.** Returns `Centavos|null`; ISO string compare preserved. | OK |
| Rate 3-step upsert | (1) same eff_start → update; (2) else close open earlier rates strictly before new date; (3) insert `period_basis='semi_monthly'` | `src/lib/pay/rates.ts:65-88` (pure plan) | spec §10 `:135-142` | Pure plan correct; the "never close future-dated" rule lives in the executor `executeRateUpsert` (`db/queries/rates.ts`) — **verify the executor honors `effective_start < newEff`** (plan only signals `closeBefore`). INFERRED: executor not read in this track. | Low (verify executor) |
| Core gross (no OT) | `ratio=min(worked/expected,5)`; `gross = ratio>=1 ? rate : round(ratio*rate)` (capped at rate) | `src/lib/pay/calc.ts:124-126` | spec §6 `:63-74`; `calc.test.ts:13-66`; `parity.test.ts:100-137` | **Correct & parity-verified** (sweep test `calc.test.ts:49-66` matches legacy float to the centavo; parity reproduces gross from stored inputs within rounding tolerance). | OK |
| Ratio cap 5 | cap at `RATIO_CAP=5` | `calc.ts:27,124` | spec `:14`,`:72` | Correct. | OK |
| Zero-expected guard | expected=0 & worked>0 → cap (legacy Infinity→cap); expected=0 & worked=0 → 0 (legacy NaN) | `calc.ts:124` | `calc.test.ts:114-126` | **Correct, improves on legacy** (legacy would produce Infinity/NaN). Documented as a deliberate degenerate-case fix. | OK |
| Shortfall | `rate − gross`, **informational, NOT subtracted from net** | `calc.ts:126`, result `:90`, draft `shortfall_php` `mappers.ts:256` | spec §6 `:75`; `calc.test.ts:36-47` | **Correct.** Net composition (`calc.ts:144-147`) never includes shortfall. Stored separately. Verified in parity (`net=gross+extras`, shortfall absent, `parity.test.ts:83-98`). | OK |
| Misc items sign | `deduction` subtracts (amount stored positive), others add; junk→0 | `calc.ts:41-49` | spec §6 `:81`; `calc.test.ts:201-214` | **Correct.** Uses `majorToMinor` (integer). | OK |
| Health allowance | hire+180 elig; anniv=`Date(year(periodStart), month(hire), min(day(hire),28))`; pay ₱20k if `periodStart<=anniv<=periodEnd AND anniv>=elig` | `src/lib/pay/allowances.ts:27-39` | spec §7 `:97-106`; `tests/lib/pay/allowances.test.ts`; parity `parity.test.ts:78` (≥10 HA rows) | **Correct.** day≤28 clamp present (`:36`); ms-based 180-day elig preserved (`:34`). All-UTC (legacy local/UTC mix fixed — documented divergence, `allowances.ts:4-10`). | OK |
| 13th month (half-annual) | `monthsWorkedInYear` = whole months + `(dayEnd−dayFrom)/30`, clamp [0,12]; `accrual=(mw/12)×rate` (=half the annual) | `allowances.ts:47-76` | spec §8 `:108-123` | **Correct;** `/30` partial-month preserved. **Parity gap:** the fixture's only t13 rows are the manual out-of-band Nov-2025 payout batch (`parity.test.ts:161-167`), so t13 formula parity is **unit-test-only, never validated against real formula-era data** (acknowledged `parity.test.ts:161`). | Low (coverage) |
| PH / PS pay | PH: `worked_hours × per-hour rate`; PS: `approved sessions × per-session rate`; no expected/ratio; no 13th accrual | `calc.ts:108-138` | post-spec extension; `calc.test.ts:128-199` | **Correct & cent-accurate** (1.5h×₱33.33→₱50.00, `calc.test.ts:145-153`). No parity fixture (feature newer than the sampled periods). | Low (no parity) |
| `usdReference` (FX) | `round(net/fx)`, reference only, never used for payout | `calc.ts:169-172` | spec §6 `:83` | **Correct** — reference only; payout currency hardcoded `'PHP'` (`mappers.ts:260`). | OK |
| Centavos rounding | `roundHalfAwayFromZero` (symmetric); `mulRatioMinor`/`majorToMinor` | `src/lib/money/index.ts:62-77,113` | spec §6 `:92-95` | **Correct** integer rounding; symmetric (fixes `Math.round` negative asymmetry). | OK |
| **Float re-entry risk** | money must stay integer until the DB boundary | `centavosToPhp = Number((v/100).toFixed(2))` `mappers.ts:20`; `amountUsd: l.amount/100` `actions/invoicing.ts:96,176` | — | **Floats reappear ONLY at the DB/UI boundary** (numeric(12,2) writes, display) — acceptable per design. Invoice line amounts are computed in integer cents and divided by 100 only for the `numeric` write; the persisted line reproduces exactly (compute.ts:14-22 note). **No float leaks into arithmetic.** | OK |
| Invoicing math | hourly `round2(hours)×round2(rate)` in cents; session `count×rate`; markup once on subtotal | `src/lib/invoicing/compute.ts:111-192` | `tests/lib/invoicing/compute.test.ts` | **Correct.** Hours rounded 2dp before multiply (matches `numeric(10,2)` storage); markup applied once (`:187`). | OK |
| invoice_no atomicity | advisory-lock + `max()+1` (not count), filtered `status<>void`, UNIQUE backstop | migration `00000000000004_invoice_no_atomic.sql` | spec/Appendix F-1 | **Correct.** `max()+1` avoids post-void reuse; advisory lock serializes; partial UNIQUE index backstops. | OK |
| Wise matcher | filterLive (drop cancelled) → ID-first refresh → recipient+window+exact (±₱1) → closest-pay-date → variance auto-override only if unambiguous | `src/lib/wise/matcher.ts` (`156-158`,`174-249`,`273-450`) | `tests/lib/wise/matcher.test.ts` | **Mostly correct, low false-match risk.** Tolerance is integer-centavo ±₱1 via `majorToMinor` (`:36`); cancelled ghosts dropped before indexing (`:156`); ambiguity guards (`:358-381`,`:411,422-425`). **RISK:** discovery picks the transfer on **list-row `created`** then fetches precise dates AFTER (`service.ts:582-595`) — decision and enrichment use different date data; and refresh path locks a recorded-`sent` row even on non-terminal live status (`matcher.ts:207-215`, deliberate). | Med (false-match edge) |
| Worker attribution | null `worker_id` → `source_name` (exact then `nameKey`); unresolved → `unattributed`, unlinked → `unlinkedWorkerIds`; never silently dropped | `src/lib/payroll/mappers.ts:70-120` | spec §6 `:86-90`; `tests/lib/payroll/mappers.test.ts:80` | **Invariant holds** (test asserts "never drops silently"). **Weakness:** calc-time matcher lacks the loose-key fallback that the import-time matcher (`lib/time/attribution.ts:50-57`) has — a name matched loosely at import could fail calc-time attribution if `worker_id` wasn't backfilled. INFERRED. | Med |
| Period state machine | open→locked→paid | `db/queries/payroll.ts` (lock `:292`, unlock `:305`, stepToLocked `:445`) | spec §9 `:125-133` | **BUG: `paid` is never set.** No code writes `state:'paid'` (grep: 0 hits). Paid-ness lives only on payment `status`. Period stalls at `locked`. | **High (state never reached)** |

---

## §3 — Simplification Opportunities

1. **Collapse the two attribution matchers.** `lib/time/attribution.ts` (strict→loose, inactive-aware) and the inline `idByName` map in `lib/payroll/mappers.ts:74-83` duplicate name resolution with different rules. Unify on the loose-key-capable matcher so calc-time attribution matches import-time behavior (also fixes the §2 attribution weakness). — `mappers.ts:70-120`, `attribution.ts:27-57`.
2. **Single net-composition helper.** `calcContractorRow` (`calc.ts:144-147`), `updatePaymentRowAction` (`payroll.ts:386-388`), and `recomputeNetCentavos` (`row-net.ts:30-39`) each re-implement `gross+ha+t13+pdd+bonus+misc`. Extract one `composeNet(parts)` used by all three to guarantee they never drift.
3. **Remove dead code / stubs:** `getPeriodCounts` (`overview.ts:35-49`), `AlertsBanner.tsx` (orphaned), the hardcoded "Payout issues" tile (`page.tsx:243`), the inert `wiseRates()` (`actions/wise.ts:281`), the disabled "Check emails" button (`WiseReconCard.tsx:97-104`).
4. **Wire `state:'paid'`** into `markPaid`/reconcile (step the period to `paid` once all payments are sent/reconciled) OR delete `'paid'` from the enum + UI to stop showing an unreachable state.
5. **Replace `.limit(100000)` reads** in invoicing queries (`db/queries/invoicing.ts:144,203`) with explicit pagination or an aggregate query.
6. **Surface document expiry on the overview** by reusing `classifyExpiry` (`lib/documents/expiry.ts`) in `overview.ts` — the pure classifier already exists.

---

## §4 — Highest-risk correctness issues (ranked)

1. **Period never reaches `paid` state (High).** `markPaid` flips payment `status` to `'sent'` but no code sets `pay_periods.state='paid'` (grep: 0 hits in `src/`). The documented open→locked→paid machine (spec §9) is really open→locked. Downstream consumers keying off period `paid` (overview pipeline `paid.done`, status pills) rely on payment-level signals instead — works today but the period state is dead/misleading and a future feature that gates on `state='paid'` would silently never fire. — `db/queries/payroll.ts:423-446`, `status-pills.ts:8-18`, enum `migration 00000000000001:126-133`.
2. **Holiday observance contradicts the spec (Med).** Code shifts weekend holidays onto adjacent weekdays so they DO reduce expected hours (`holidays.ts:61-66,127-145`); spec §4 (`:49`) says they should NOT. Parity data matches the **code**, so the spec text is stale — but anyone trusting the spec will mis-audit expected-hours/gross. Update the spec; add an explicit weekend-observance parity assertion.
3. **Wise false-match edge: decision vs enrichment date mismatch (Med).** Discovery chooses the winning transfer using list-row `created`, then fetches precise `dateSent`/`dateFunded` only after (`service.ts:582-595`). Two same-recipient, near-equal-amount transfers close in time could be tie-broken on the coarser field. Mitigated by ±₱1 tolerance + 1-day true-tie guard, but the two stages should use the same date source.
4. **Calc-time attribution lacks the loose-key fallback (Med).** A worker matched only by loose name at import, whose `worker_id` wasn't backfilled, can fall into `unattributed[]` at calc time even though import "knew" them. — `mappers.ts:91-99` vs `attribution.ts:50-57`.
5. **E-sign scroll-gate is fabricated (Med — legal, out of money-core but flow-relevant).** `scrolled_to_end` hardcoded `true` (`portal.ts:454`); no client tracking. Read-to-end attestation is not real evidence.
6. **13th-month + PH/PS have no real-data parity (Low).** t13 formula parity is unit-only (the only t13 fixture rows are a manual payout batch, `parity.test.ts:161-167`); PH/PS post-date the sampled periods. Formula is correct by unit test but unproven against production.

---

## §5 — Coverage note

**Strong parity coverage (OBSERVED):**
- `tests/lib/pay/parity.test.ts` — 117 real paid rows (2024-02→2026-05), asserts net=gross+extras, gross reproduction from stored inputs, ratio 4dp, expected-hours reproduction, and explicitly carves out documented anomalies (Wise `original_net_php`, Nov-2025 manual t13 batch, April-2026 rate restructure, 12 post-hoc annotations). This is a genuine oracle, not a smoke test.
- Unit tests exist for every pure money module: `calc`, `allowances`, `expected-hours`, `holidays`, `periods`, `rates` (via calc.test), `money` (implied), `invoicing/compute`, `wise/matcher`, `time/attribution`, `payroll/mappers`, `payroll/row-net`, `payroll/bank-export`, `hubstaff/transform`, `hubstaff/vendored-parity`, `wise/vendored-parity`, plus `payroll/batch-parity`.

**Coverage gaps (OBSERVED / INFERRED):**
- **13th-month formula parity** — no real formula-era rows (only the manual batch). Unit-only.
- **PH/PS** — no parity fixture (feature newer than sampled data).
- **Weekend-holiday observance** — no explicit parity assertion isolating the Sat→Fri/Sun→Mon shift (it's only indirectly covered by the FT/PT expected-hours reproduction).
- **Rate upsert executor** (`db/queries/rates.ts executeRateUpsert`) — the "never close future-dated rate" SQL is not exercised by a pure test in this track's view; the pure *plan* is tested but the executor's `effective_start < newEff` close is INFERRED.
- **Period state transitions** — no test asserts a period ever reaches `paid` (because it never does — see §4.1).
- **Server-action integration** — only `tests/server/actions/time.test.ts` exists; payroll/wise/invoicing/onboarding server actions have no integration tests (pure logic is covered; orchestration + RLS-scoping is not).
- **No try/catch resilience test** for the overview `Promise.all` fail-fast.

---

### Key files
- `src/lib/pay/{calc,expected-hours,rates,allowances,holidays}.ts`, `src/lib/dates/periods.ts`, `src/lib/money/index.ts`
- `src/lib/payroll/{mappers,row-net,status-pills}.ts`, `src/lib/invoicing/compute.ts`, `src/lib/wise/matcher.ts`, `src/lib/time/attribution.ts`, `src/lib/hubstaff/transform.ts`
- `src/server/payroll.ts`, `src/server/actions/{payroll,time,hubstaff-sync,wise,reconcile,invoicing,import,contractors,onboarding,portal}.ts`
- `src/server/wise/{service,client}.ts`, `supabase/functions/{wise-payouts,hubstaff-sync}/index.ts`
- `src/db/queries/{payroll,invoicing,overview,wise}.ts`
- `supabase/migrations/00000000000004_invoice_no_atomic.sql`, `supabase/migrations/00000000000001_baseline_abc_schema.sql` (enum `:126-133`)
- `scripts/guardrails.mjs`
- `tests/lib/pay/parity.test.ts`, `tests/lib/pay/calc.test.ts`, `docs/money-core-spec.md`
