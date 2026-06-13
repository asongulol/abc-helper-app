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

## Recommended cutover sequence (Phase 6)

1. Between pay periods, freeze writes on the old app.
2. Apply any new migrations to prod (additive only — old app stays a valid
   rollback).
3. `pnpm parity:verify --url <prod> --key <service_key>` → must exit 0.
4. Set prod env in Vercel (see `docs/DEPLOY.md`), deploy, flip the URL.
5. Keep the old app deployed as the rollback until a full clean period runs.
