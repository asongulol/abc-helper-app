---
title: Coverage & reports
sidebar_position: 8
---

# Coverage & reports

The reporting surfaces that sit alongside the pipeline: **coverage** (are contractors working
their expected hours?), **reports** (historical pay, YTD, utilization), and the **overview**
dashboard (current-period health). None of these mutate pay — they read and classify.

## Coverage

Coverage answers "is this contractor working the hours we expect?" for a period.

- **Expected hours** resolve from `coverage_targets` (an explicit `target_hours` per worker, per
  company, per `period_kind` of `weekly`|`semi_monthly`, effective-date windowed). If there's no
  target, it falls back to `worker_companies.weekly_hours × weeks_in_period`; weekly targets are
  scaled the same way. `fetchCoverageExpectations()` (`src/db/queries/coverage.ts`) does this
  resolution (company-specific target beats employer-wide; latest `effective_from` wins).
- **Actual hours** = `Σ tracked_seconds / 3600` for the worker+company+period
  (`fetchActualHours()`, PTO excluded upstream).
- **Classification** is pure: `classifyCoverage(expectations, actuals, underThreshold = 0.6)`
  (`src/lib/coverage/classify.ts`) flags two gap kinds, sorted worst-first:

  | Gap | Condition |
  |---|---|
  | `zero_time` | expected > 0 but worked = 0 |
  | `under_coverage` | worked < 60% of expected (default threshold) |

  Workers with no expected hours aren't flagged. `getCoverageGaps()` chains fetch → fetch →
  classify; coverage gaps also surface on the overview dashboard.

**Managing targets** (`src/server/actions/coverage.ts`, admin + company-scoped): `setCoverageTarget()`
replaces the open target for `(worker, company, period_kind)` with `effective_from = today`;
`clearCoverageTarget()` deletes it (reverting to the `weekly_hours` fallback). Both write an audit
event. The `/coverage` page uses `fetchCoverageRoster()` to drive the management UI.

## Reports

Four report shapes, all PHP money carried as **integer centavos** until the display/CSV boundary.

| Report | Entry | Grain |
|---|---|---|
| **Payout by period** | `getReportsData()` (`src/server/actions/reports-detail.ts`) | period → contractors; net, USD-ref, unpaid count |
| **Contractor pay summary** | `getReportsData()` | per-worker YTD (gross, HA, 13th, net, period count) |
| **Contractor history** | `getContractorHistory()` | per-worker pay statements merged with time entries, by period |
| **Utilization** | `getUtilization()` | per-worker, per week (Mon–Sun): avg `activity_pct` + tracked hours |

`getReportsData()` pages the full payments set (working around PostgREST's 1000-row limit),
groups by period, and aggregates per contractor — a faithful port of the legacy
`Reports()` / `PerContractorSummary()`. The underlying queries
(`fetchReportPeriods`, `fetchContractorYtd`, `fetchReportPayments` in `src/db/queries/reports.ts`)
return centavos.

**CSV export** is pure (`src/lib/reports/csv.ts`): `buildPeriodSummaryCsv()` and
`buildPaymentDetailCsv()` format money as PHP 2 dp with CSV-safe escaping; `downloadCsv()`
triggers the browser download. The detail export is driven by `getReportDetail()`
(`src/server/actions/reports.ts`) — server-side because the RLS user client is required, then the
client builds the file. The payment-detail columns mirror the payment row (gross, HA, 13th,
PDD/lunch, bonus, perf-shortfall, net, payout method, status — see [Pay pipeline](./pay-pipeline.md)).

## Overview dashboard

`/overview` (`src/app/(admin)/overview/page.tsx`) runs the `src/db/queries/overview.ts` queries in
parallel for the current semi-monthly period:

- **KPI tiles** — `countActiveContractors`, `getPeriodNetTotal`, `countPendingTimeApprovals`,
  `countFailedPayouts`.
- **Pay-cycle pipeline** — `getPipelineData()` returns the 5 stages (time imported → approved →
  calculated → locked → paid), each `{ done, detail }`, visualizing where the current period sits.
- **Net sparkline** — `getRecentPeriodNets()` (recent locked/paid periods) rendered via the pure
  `src/lib/overview/spark.ts` (`toSparkPoints` → `toPixelPoints` → `toPolylinePoints`),
  computed in integer centavos to avoid float drift.
- **Alerts** — `getAlerts()` flags `no_rate` (approved time but no effective rate) and
  `no_payout_method`.
- Plus coverage gaps, onboarding progress, and recent documents.

This dashboard is the operational "is this period ready to pay?" view; the pipeline strip mirrors
the stages in [Pay pipeline](./pay-pipeline.md).
