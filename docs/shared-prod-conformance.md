---
title: Shared-prod conformance
sidebar_position: 11
---

# Shared-prod conformance

abc-helper-app does not get its own database. It runs on the **same production Supabase
project** (`cgsidolrauzsowqlllsz`, "ABC HR-Payroll App") as the three live original apps
(`abc-work-app-payroll-wis-hubstaff-app`, `-admin-redesign`, `-mobile`). This page is the
quick overview; the full reasoning, scope, and PR breakdown live in
[PROD-CONFORMANCE-PLAN.md](./PROD-CONFORMANCE-PLAN.md).

## Why

This is a **Strangler Fig** cutover: abc-helper-app replaces the originals one capability at a
time, but until they are decommissioned all four apps read and write the **same shared schema**.
That forces one rule:

> Every prod schema change must be **ADDITIVE**. Never rename, drop, or retype an existing prod
> object — the old apps are the rollback, and they must keep working.

The 2026-06-22 incident is the cautionary tale: renaming `deduction_php` → `shortfall_php` on
shared prod broke all three live apps at once. The fix was to bend abc-helper-app back to prod's
names (see [Money core spec](./money-core-spec.md)), not the reverse.

A second consequence: the repo's local migration lineage is squashed and **disjoint** from prod's
21 timestamped migrations. So the repo migrations describe a *from-scratch* schema for local dev
and CI — they must **never** be pushed to prod, which already has those objects.

## Safety rails

Three layers stop a repo migration from ever reaching shared prod. This is the part to internalize.

| Layer | What it does | Source |
|---|---|---|
| **`npm run db:guard`** | Reads `supabase/.temp/project-ref`; exits 1 if linked to the prod ref. `db:push` runs it first (`"db:push": "npm run db:guard && supabase db push"`). | `scripts/assert-local-supabase-target.mjs` |
| **In-DB backstop** | Migration `0000…0000` runs *before* the baseline and `RAISE EXCEPTION`s if the target carries `public.my_clients()` (a function only the originals/prod have). Catches a raw `supabase db push` the npm wrapper bypasses. | `supabase/migrations/00000000000000_assert_not_shared_prod.sql` |
| **The rule** | Never run `supabase db push`, `migration repair`, or `db reset --linked` against prod. Prod changes go **only** via `audit/*.sql`, applied by hand in the Dashboard SQL Editor, one reviewed statement at a time. | — |

Note: `db guard` only guards `db push`. A `supabase db reset --linked` drops the schema *before*
the in-DB guard runs, so it is **never** safe against prod — the project-ref check is what protects
you there.

## What was conformed

There are two directions of divergence, and they are handled differently.

### Prod has it, repo lacked it — added to **local** schema only

These objects already exist on prod, so nothing was applied there. They were added to the repo
baseline (migration `019`, `00000000000019_prod_parity_columns.sql`) so `supabase db reset` builds
a local DB that mirrors prod. **Never pushed.**

| Object | Notes |
|---|---|
| `contract_type` enum gains **`PHS`** | The originals' per-hour/per-session model (`PHS` + `pay_basis`); the engine now pays it correctly — see below. |
| `payments.contract`, `payments.pay_basis`, `payments.units` | Snapshotted onto each payment; `units` carries the session count for `per_session` rows. |
| `payments.funded_at`, `payments.funded_by`, `payments.fund_error` | Wise funding workflow — owned by the originals; app-unwritten. |
| `worker_companies.pay_basis` | `hourly` / `per_session` discriminator for PHS. |
| `companies.api_payouts_enabled` | |
| `documents.defer_until` | |
| index `payments_unfunded_drafts` | Partial index over unfunded wise-initiated drafts. |

(The diff `audit/repo-to-prod-schema-diff-2026-06-22.sql` also lists index
`service_sessions_external_ref_unq` in this direction.)

### Repo has it, prod lacked it — added to **prod** additively, by hand

These are abc-helper-app capabilities prod did not have. A sibling-grep across all three live apps
returned **0** references to each, so adding them cannot affect the originals. Applied via the
Dashboard SQL Editor from `audit/prod-additive-conformance.sql` (idempotent; do **not** run via the
migration CLI; do **not** append `rollback;`).

| Object | Source | Status |
|---|---|---|
| `coverage_targets` table (+ its RLS, indexes) | `audit/prod-additive-conformance.sql` | Awaiting manual apply |
| `invoices.amount_received_usd`, `invoices.received_on`, `invoices.payment_ref` | `audit/prod-additive-conformance.sql` | Awaiting manual apply |
| `worker_tools.revealed_at` (nullable column only) | `audit/prod-additive-conformance.sql` | Awaiting manual apply |
| function `my_tools_pending()` (read-only self-scoped boolean) | `audit/prod-additive-tools-functions.sql` | **Applied + verified on prod 2026-06-23** |

The worker-tools reveal flow adopted prod's **persistent** model rather than abc-helper-app's
one-time reveal-and-purge (purging `worker_tools.enc` would delete credentials the live apps still
re-read). Admin reveal now calls prod's existing `decrypt_worker_tools(uuid)` (persistent), and
local migration `020` (`00000000000020_worker_tools_persistent_model.sql`) makes `get_my_tools()`
persistent and drops the purging `reveal_worker_tools`. abc-helper-app's purge functions were
deliberately **not** deployed to prod.

**Not confirmed:** the brief mentioned "`app_secrets` entries." The audit SQL files contain no
`app_secrets` additive statements — `app_secrets` appears only as an existing prod object that the
worker-tools functions read (`tools_enc_key`). No `app_secrets` change was applied as part of this
conformance.

## The `deduction_php` naming gotcha

`deduction_php` is **prod's column name** — and it is misleading. It does **not** hold a real
deduction. It carries the **informational performance shortfall** (`rate − gross`) and is **never
subtracted from net**. Real deductions flow through `misc_items[kind=deduction]`.

abc-helper-app internally and in the UI calls this line "performance shortfall" / "perf short" — the
same honest label the originals use — while persisting it to the prod-named `deduction_php` column.
The originals' computation is identical (`rate − gross`, never in net), so conforming the name was a
pure rename with no calc or parity impact. Details:
[Pay pipeline](./pay-pipeline.md) and [Money core spec](./money-core-spec.md).

## Pointers

- [PROD-CONFORMANCE-PLAN.md](./PROD-CONFORMANCE-PLAN.md) — the full plan: decision, scope, PR
  sequencing, risks, and the PHS contract-model finding.
- `audit/prod-additive-conformance.sql` — exact DDL for the prod additions (coverage_targets,
  invoice AR columns, `worker_tools.revealed_at`).
- `audit/prod-additive-tools-functions.sql` — `my_tools_pending()` (applied).
- `audit/repo-to-prod-schema-diff-2026-06-22.sql` — the raw repo→prod diff this was derived from.
- `supabase/migrations/00000000000019_prod_parity_columns.sql` and `…020_worker_tools_persistent_model.sql`
  — the local-only parity migrations.
- Related: [Local development](./local-development.md) · [Data model](./data-model.md).
