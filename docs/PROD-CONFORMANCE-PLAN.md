# abc-helper-app → Shared Prod DB Conformance Plan

> **Status:** PLAN ONLY. No code/schema changes made. Written 2026-06-22.
> **Goal (user decision):** abc-helper-app **replaces** the original apps and runs on the
> **same shared prod DB** `cgsidolrauzsowqlllsz` ("ABC HR-Payroll App"). **No separate database.**

---

## 0. Decision & guardrails

- abc-helper-app must **conform to prod's actual schema** — it bends to prod, never the reverse.
- Until the originals (`abc-work-app-payroll-wis-hubstaff-app`, `-admin-redesign`, `-mobile`) are
  decommissioned, **they remain live on the same DB**. So every change is judged by: *does this break
  the originals?*
- **Hard rules (from the 2026-06-22 incident):**
  - **Never `supabase db push` / `migration repair` against prod** (repo history is squashed & disjoint
    from prod's 21 timestamped migrations).
  - **Never rename/drop/alter an existing prod object the originals use.** The incident was caused by
    renaming `deduction_php`→`shortfall_php` on shared prod, which broke all three live apps.
  - **Additive-only on prod**, and only after grepping all three sibling apps to confirm they don't
    touch the object. Apply via Dashboard SQL Editor (or psql), one reviewed statement at a time —
    **not** the migration CLI.

---

## 1. Key finding: the money-column divergence is **name-only** (zero behavior change)

I verified the originals' actual computation, not just the column name:

`abc-work-app-payroll-admin-redesign/app/index.html:4963-4970`
```js
const ded = rate==null ? 0 : +(rate-(gross||0)).toFixed(2);            // rate − gross
const net = gross==null ? null : +(gross+ha+t13+pdd+bonus+miscSum)...; // ded NOT in net
... deduction_php: r.ded ...                                            // stored, informational
```

So the original's **`deduction_php` == abc-helper-app's `shortfall_php`**: `rate − gross`,
**informational, never subtracted from net**, with *real* deductions flowing through
`misc_items[kind=deduction]`. The models are **identical**. Renaming `shortfall_php`→`deduction_php`
is purely nominal — **no calc change, no net change, no parity risk.**

---

## 2. ⚠️ Naming decision needs re-confirming (new evidence contradicts the premise)

You chose *"rename internal + UI vocabulary to **deduction** to match the originals exactly."* But the
evidence shows the originals **do not** call this line "Deduction" in the UI:

- The original deliberately labels the `deduction_php` line **"Perf short PHP"**, with an inline comment
  (`admin-redesign/app/index.html:6438-6443`): *"the deduction_php column is the rate−gross performance
  shortfall — labeled 'Perf short PHP' so it isn't read as an actual withholding."*
- The original reserves the word **"Deduction"** for *real* subtractions from net, stored in
  `misc_items[kind=deduction]` (`...:6002-6008` "Deductions (subtracted from Net)") — which abc-helper-app
  already does identically.

**Implication:** abc-helper-app and the originals already share the honest UI label
("performance shortfall" ≈ "perf short"). Relabeling abc-helper-app's UI to "Deduction" would
*diverge* from the originals and reintroduce the exact confusion they avoid.

**To "match the originals exactly," the faithful change is:**
| Layer | Action |
|---|---|
| **DB column name** | `shortfall_php` → **`deduction_php`** ✅ (this is the *only* real divergence; required) |
| **Internal identifiers** | optional: `shortfallPhp`/`shortfall` → `deductionPhp`/`ded` to mirror the column. Cosmetic; no functional effect. |
| **UI / CSV label** | **keep** "Performance shortfall" / change CSV header `"Shortfall PHP"` → **`"Perf short PHP"`** to match the original. **Do NOT relabel the line "Deduction."** |

➡️ **Decision to confirm before I execute (§8):** do you want the contractor/admin-facing label kept as
"performance shortfall / perf short" (matches originals — recommended), or literally changed to
"Deduction" (diverges from originals)?

---

## 3. Scope: three categories of divergence

`supabase db diff --linked` (artifact: `audit/repo-to-prod-schema-diff-2026-06-22.sql`) describes how to
transform **repo schema → prod schema**. Reading it that way:

### (A) Renames — resolve in REPO only, **zero prod change**
- `payments.shortfall_php` (repo) is `payments.deduction_php` (prod).

### (B) Prod **has**, repo **lacks** — add to repo's local schema so dev matches prod (zero prod change)
- `contract_type` enum gains **`PHS`** — ⚠️ **NOT a simple enum add; deferred to its own PR.** See §9. `PHS`
  is the originals' *current* per-hour/session model (`contract='PHS'` + `worker_companies.pay_basis ∈
  {hourly, per_session}`). abc-helper-app uses separate `PH`/`PS` and reads no `pay_basis`, so widening
  the enum alone would make its calc pay a `PHS` worker as **salaried** (overpayment). Excluded from
  migration 019 on purpose.
- `payments.{contract, fund_error, funded_at, funded_by, pay_basis, units}`
- `worker_companies.pay_basis`
- `companies.api_payouts_enabled`
- `documents.defer_until`
- indexes `payments_unfunded_drafts`, `service_sessions_external_ref_unq`
- (functions/policies prod defines that repo doesn't: `decrypt_worker_tools`, `my_clients`,
  `get_my_tools`, `set_worker_tools`, several policies — see diff lines 243-394)
- *Runtime impact:* mostly none (app reads 0 of the funding cols today). `units` shows 86 grep hits but
  those are unrelated "units" (session units / tests) — **verify** none read `payments.units`.

### (C) Repo **has**, prod **lacks** — the dangerous category. Split by whether the **app uses it at runtime**:

**C1 — app DOES use it → MUST resolve (else it breaks against prod):**
| Object | Runtime refs | Resolution |
|---|---|---|
| `coverage_targets` table (mig 017) | 11 — `src/server/actions/coverage.ts`, `src/db/queries/coverage.ts` (read + insert; falls back to `worker_companies.weekly_hours`) | Originals never reference it ⇒ **add to prod additively** (new table + its RLS), OR feature-gate coverage. |
| `invoices.{amount_received_usd, payment_ref, received_on}` | 7 each — AR receipt tracking | Confirm originals track AR differently ⇒ **add 3 nullable columns to prod additively**, OR move to misc/separate. |
| `worker_tools.revealed_at` | 3 | Confirm originals don't use it ⇒ **add nullable column additively**, OR drop the feature. |

**C2 — app does NOT use it (pure integrity / dev-side) → keep LOCAL-only, never required on prod:**
- CHECK constraints: `payments_amounts_nonneg`, `payments_misc_items_valid`, `invoices_*`,
  `rates_amount_nonneg`, `worker_companies_rates_nonneg`
- `payments_period_open_enforce` trigger (mig 018)
- functions `my_tools_pending`, `reveal_worker_tools`, `worker_has_payment_in_period`
- the `shortfall_php` rename migration 003 (will be deleted — see §4A)

> Anything in C1 that we add to prod is an **additive, non-conflicting** change (new table / new nullable
> columns the originals never read or write). That is the normal, safe way two apps coexist on one DB —
> categorically different from the incident's *rename*. Each still gets a grep-all-siblings check first.

---

## 4. Work breakdown (repo-side branch + PR; prod additions staged separately as reviewed SQL)

### 4A. Money column `shortfall_php` → `deduction_php`

**Wire layer (DB-facing — REQUIRED for the app to work against prod):**
- `src/db/queries/payroll.ts:674` & `:715` — `.select(...)` strings; `:696` `data.shortfall_php`; `:735` `p.shortfall_php`
- `src/db/queries/portal.ts:58` select string; `:74` `p.shortfall_php`
- `src/db/queries/reports.ts:224` select string; `:249` `p.shortfall_php`
- `src/lib/payroll/mappers.ts:289` insert-payload field; `:325` `shortfall_php: …` (this object is written to DB)
- `src/server/actions/reports-detail.ts:170` field type; `:191` select string; `:286,:337,:351` `p.shortfall_php`
- `src/db/types.ts:949,979,1009` — regenerate (see §4E)

**Internal identifiers (NOT on the wire — rename only if we mirror the column name):**
- `src/lib/pay/calc.ts:94-99,122,135,142,171` — `shortfall` result field (+ update the comment that argues
  for the name "shortfall" over "deduction")
- `src/db/queries/payroll.ts:346-347,646-647`, `portal.ts:24-25` — `shortfallPhp`
- `src/db/queries/reports.ts:54-55` — `shortfallCentavos`
- `src/lib/payroll/mappers.ts:325` `r.shortfall`; `src/server/actions/reports-detail.ts:286` `perfShort` (already "perf short")

**UI/label layer (the §2 decision):**
- `src/components/print/PaySlip.tsx:139,151,153` — "Performance shortfall — informational"
- `src/components/reports/ReportsClient.tsx:338` — "Performance shortfall = rate − gross…"
- `src/lib/reports/csv.ts:65` — CSV header `"Shortfall PHP"` → recommend `"Perf short PHP"` (matches original)

**Local schema (so `supabase db reset` builds `deduction_php`):**
- `supabase/migrations/00000000000001_baseline_abc_schema.sql:874` column def, `:898` comment, `:465`
  trigger col-check → `deduction_php`
- **Delete** `supabase/migrations/00000000000003_rename_deduction_to_shortfall.sql` (it renames the wrong
  direction; with the baseline fixed, it's obsolete)
- `supabase/migrations/00000000000014_rls_integrity_guards.sql:74` and
  `00000000000018_payments_period_open_enforce.sql:53` → `deduction_php`

### 4B. Add prod-has/repo-lacks to local schema
New migration(s) adding the §3(B) objects to the local baseline so dev/CI match prod (enum `PHS`,
funding columns, `pay_basis`, `api_payouts_enabled`, `defer_until`, the two indexes, and prod's
functions/policies that the repo lacks). Pure local — never pushed.

### 4C. Resolve repo-has/prod-lacks that the app uses (§3 C1)
Per object: grep all three siblings to confirm non-conflict, then **stage an additive prod SQL script**
(`audit/prod-additive-conformance.sql`) for deliberate Dashboard-SQL-Editor apply — *separate from the
repo PR, reviewed line-by-line.* Fallback if any conflict found: feature-gate that capability in
abc-helper-app instead.

### 4D. Repo-only integrity (§3 C2) → leave in local migrations, mark clearly local-only, never push.

### 4E. Regenerate types
After fixing the baseline + local migrations: `supabase db reset` (local stack) → `supabase gen types
typescript --local` → overwrite `src/db/types.ts`. (Note: local will also contain C1 extras; that's fine
for dev. The invariant is that the app's schema expectations are a **subset of prod** once §4C lands.)

### 4F. Tests & docs
- `tests/lib/pay/calc.test.ts:22,45,78,140` — `r.shortfall` (only if we rename the calc field in 4A).
- Update `docs/RECREATION-RECOMMENDATIONS.md:48,93` and `docs/money-core-spec.md:79,136`
  (these currently *recommend* `shortfall_php` — reverse that guidance).
- `audit/*.md` references are historical; leave or annotate.

---

## 5. Validation (all local — no prod)
1. `supabase db reset` builds cleanly through every migration (no `shortfall_php` anywhere; `deduction_php`
   present; `PHS` in the enum).
2. `npm test` green (esp. `calc`, `parity`, `mappers`, payroll).
3. `npm run build` / typecheck clean after `types.ts` regen.
4. Manual: point a local app build at a **scratch** Supabase project seeded with prod's schema (NOT shared
   prod) and exercise payroll draft → load → report → portal → CSV.

## 6. Sequencing / PRs
1. **PR A (repo-only, safe):** §4A + §4B + §4D + §4E + §4F. Makes the repo speak prod's names and reproduce
   prod's schema locally. No prod change. This alone makes the app correct against prod **for everything
   except the C1 objects.**
2. **Staged prod SQL (separate, reviewed, NOT a PR auto-apply):** §4C additive script — only after
   sibling-grep sign-off, applied by you via Dashboard SQL Editor.
3. Only after both: repoint the deployed app's env at shared prod (if not already).

## 7. Risks & rollback
- **Repo PR (A):** low — pure rename + local schema; reverts via git; no prod surface.
- **Prod additive SQL (C1):** medium — mitigated by additive-only, sibling-grep, one-statement-at-a-time,
  and each having a paired `drop … if exists` rollback. Never touches existing prod columns the originals use.
- **Biggest residual risk:** a C1 object the originals *do* use under a different code path we missed →
  the grep-all-siblings step is the gate. If in doubt, feature-gate instead of adding to prod.

## 8. Open decisions for you
1. **UI label (§2):** keep "performance shortfall / perf short" (matches originals — **recommended**) or
   literally relabel to "Deduction" (diverges)?
2. **Internal identifier rename:** mirror the column (`shortfallPhp`→`deductionPhp`) for consistency, or
   leave internal names as-is to minimize diff? (No functional effect either way.)
3. **C1 strategy** (`coverage_targets`, invoice receipt cols, `revealed_at`): **add additively to prod**
   (recommended, after sibling-grep) or **feature-gate/remove** from abc-helper-app for now?

---

## 9. STATUS (2026-06-22) + the PHS contract-model finding

### ✅ Shipped in this PR (`conform/payments-deduction-php-prod-schema`) — repo-only, no prod change
- **Money column conformed:** every DB-facing `shortfall_php` → **`deduction_php`** (wire selects,
  insert payload, response reads, baseline + migs 014/018; obsolete rename migration 003 deleted).
  Internal `shortfallPhp`/`shortfall` names and the "performance shortfall" UI label **kept** (they match
  the originals, which label this line "Perf short", not "Deduction"). CSV header → "Perf short PHP".
- **Verified semantics identical** (rate − gross, never in net) against the originals — pure rename, no
  calc/parity change.
- **Parity migration 019** adds prod's nullable columns locally (`payments.{contract, pay_basis, units,
  funded_at, funded_by, fund_error}`, `worker_companies.pay_basis`, `companies.api_payouts_enabled`,
  `documents.defer_until`, index `payments_unfunded_drafts`). Additive, idempotent, **never pushed to prod**.
- **Validated:** `supabase db reset` (001→019 clean), `supabase gen types` regenerated `src/db/types.ts`,
  `tsc --noEmit` clean, **406/406 vitest pass**, biome clean.

### ✅ PR 2 SHIPPED — "contract-model conformance" (PHS) — Option 1 (adopt PHS)
The originals consolidated per-hour/per-session into **one** `contract='PHS'` + `pay_basis` discriminator;
abc-helper-app used **two** types `PH`/`PS` and ignored `pay_basis`. **Chosen: Option 1** — abc-helper-app
now reads *and writes* `PHS` + `pay_basis`, keeping `PH`/`PS` only for paying legacy rows. Delivered:

- **Engine** (`expected-hours.ts` `payModelFor` + `dayHoursFor`; `calc.ts`; `mappers.ts`): a single
  `PayModel` normalises (contract, pay_basis) → `salaried | per_hour | per_session | unset`.
  `per_hour` ≡ legacy PH, `per_session` ≡ legacy PS. **Safety:** an `unset` PHS (missing/invalid
  pay_basis) forces gross/net **null** + a `payBasisUnset` flag — never paid worked×rate, never lockable.
  PHS → expected 0, ratio 0, no 13th-month accrual. Contract + pay_basis are snapshotted onto the payment.
- **Plumbing**: `pay_basis` selected in the roster query → `RosterRow` → mapper → calc; per-session
  pull-in now includes PHS+per_session; F4 date-aware gross branches on the model.
- **Schema/UI**: `ContractTypeSchema` gains `PHS`; `PayBasisSchema`; `CONTRACT_OPTIONS` → FT/PT/PHS;
  Add/Save/Hire schemas require a pay_basis when PHS (superRefine). All three contractor forms
  (quick-add modal, hire wizard, profile tab) show a pay-basis selector for PHS; legacy `PH`/`PS` map to
  `PHS`+basis on edit-load so saving migrates the row. Write actions persist `pay_basis`.
- **Local enum**: migration 019 now re-adds `PHS` (safe — the engine pays it correctly).
- **Validated**: `supabase db reset` 001→019 clean · `tsc` clean · **413/413 vitest** (incl. PHS=PH/PS
  parity, unset-basis safety, pull-in, no-13th) · biome clean.

### ⏭ Also still pending (from §4C, unchanged): add the 3 repo-only objects the app uses
(`coverage_targets`, `invoices.{amount_received_usd,payment_ref,received_on}`, `worker_tools.revealed_at`)
to prod **additively** via reviewed SQL Editor, after grepping all three siblings. Decision: "Add to prod
additively" (chosen). Not done yet — separate staged step.
