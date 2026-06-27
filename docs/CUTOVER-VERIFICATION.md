# Cutover verification — parallel parity (Phase 5)

Before flipping production from the old app to `abc-helper-app`, prove the new
payroll engine reproduces what the old one paid. Two layers:

## 1. Offline oracle (runs in CI, every push)

- `tests/lib/pay/parity.test.ts` — row-level: the new `calcContractorRow` math
  vs **117 real paid rows** sampled from prod (HA, 13th, prorated, FT/PT,
  overrides). All pass within documented tolerances.
- `tests/lib/payroll/batch-parity.test.ts` — pipeline-level: the full
  `attributeTimeEntries → buildStatements → toPaymentDraft` chain, driven from
  reconstructed inputs, reproduces stored gross to the centavo.

These gate every commit. CI red = parity broken.

## 2. Live gate (run before cutover)

`pnpm parity:verify` (`scripts/parity-verify.mjs`) — READ-ONLY. Points at any
Supabase DB (service key), replays the gross formula over EVERY paid period, and
diffs against stored `payments`. Exits non-zero on any unexplained mismatch, so
it can gate a cutover script.

```sh
# against prod (read-only) at cutover:
pnpm parity:verify --url https://<prod>.supabase.co --key <service_key>
pnpm parity:verify --since 2026-01-01 --json parity-report.json
```

### Result on the live prod dataset (2026-06-13)

Of **1,067 paid rows**:

| Bucket | Count | Meaning |
|--------|------:|---------|
| **Checkable → matched** | **35 / 35 (100%)** | formula reproduces stored gross to the centavo |
| Manual gross override | 290 | `note` set — intentionally differ |
| Wise net-override | 52 | `original_net_php` set by the Wise matcher |
| No stored `expected_hours` | 672 | early periods, predate the app storing it |
| Known special periods | 18 | Nov-2025 manual 13th batch + Apr-2026 rate restructure |

**Every row whose payout is reproducible from stored inputs reproduces exactly.**
The 672 "no stored expected_hours" rows are early, already-paid, immutable
periods that can't be reverified from stored data alone — they are not what
cutover risks. Coverage is strongest going forward: every new period stores
`expected_hours`, so the gate fully covers all post-cutover payroll.

## Recommended cutover sequence

The new app is staged ahead of time at the new subdomain `3a.abbilabs.com` (admin at `/`,
portal at `/portal`) while the old app keeps serving users — see `docs/CUTOVER-RUNBOOK.md`
for the full prepare-now / flip-later runbook. At the flip, between pay periods:

1. Freeze writes on the old app.
2. Keep the **legacy** Hubstaff edge function + its prod cron as the **single
   syncer** (refresh tokens are single-use). Do **NOT** deploy abc-helper's
   `hubstaff-sync` / `wise-payouts` edge functions to the shared prod project —
   that overwrites the legacy v10 functions the live apps depend on. The vendored
   `supabase/functions/` are local-dev only.
3. Apply any schema changes to prod additive-only **via the Dashboard SQL Editor,
   never the migration CLI** (abc-helper migrations are local-only; a push re-runs
   the baseline on the live DB). Old app stays a valid rollback.
4. `pnpm parity:verify --url <prod> --key <service_key>` → must exit 0 (read-only).
5. Announce `3a.abbilabs.com` to users. **Single-own the two digest crons** in this
   window: remove the legacy `documents-expiry-check` / `hiring-docs-review-check`
   crons and schedule the new `/api/cron/{doc-expiry,hiring-review}` digests. Leave
   the Hubstaff/Wise crons legacy-owned.
6. Keep the old app deployed at `payroll.*` / `portal.*` as the rollback until **two
   full clean pay periods** run on the new app.

The authoritative, fuller runbook + risk register is `audit/CUTOVER-PLAN-2026-06-24.md`.
