# ABC Money Core — Port Spec (Phase 1)

Extracted from `app/index.html` (13,012 lines) on 2026-06-12. Line numbers verified.
Target: pure TypeScript modules in `abc-helper-app/src/lib/`, money as integer **centavos**
(branded type, copied from NPM-Helper-App `src/lib/money/`), ADR-0006/0012 conventions.

## Constants (line 5802)

```
HA_ANNUAL = 20000 PHP (= 2_000_000 centavos)   health allowance, once per year
HA_ELIG_DAYS = 180                              eligibility: hire + 180 days
PERIODS_PER_YEAR = 24                           semi-monthly
FT_DAY_HOURS = 8, PT_DAY_HOURS = 4              per working day by contract
RATIO_CAP = 5                                   worked/expected cap ("matches workbook V")
Default FX = 58.0 PHP/USD (live from open.er-api.com; reference only — paid in PHP)
```

## 1. `periodFor(dateStr)` — line 5901 → `src/lib/dates/periods.ts`

Semi-monthly arrears periods. Input ISO date string, local-day semantics.

- day ≤ 15 → `{start: Y-M-01, end: Y-M-15, payDate: last day of SAME month}`
- day ≥ 16 → `{start: Y-M-16, end: Y-M-(last), payDate: 15th of NEXT month}` (Dec → Jan next year)

## 2. `periodDates(p)` — line 5337

Every ISO date from start to end inclusive. Pure date iteration, no tz lib needed —
use NPM-Helper-App's `CalendarDate` UTC-day math to avoid DST artifacts.

## 3. Holiday engine — lines 5809–5848 → `src/lib/pay/holidays.ts`

`defaultHolidays(year)` computes the office's 10 observed US holidays:
New Year's (Jan 1), MLK (3rd Mon Jan), Good Friday (Easter − 2, anonymous Gregorian
algorithm), Memorial (last Mon May), Independence (Jul 4), Labor (1st Mon Sep),
Indigenous Peoples' (2nd Mon Oct), Thanksgiving (4th Thu Nov) + day after, Christmas (Dec 25).

Legacy stores per-year overrides in `localStorage["holidays_"+year]`. **Port decision:**
make the holiday list a function parameter (pure); persistence moves to DB or config later.
`holidaysInRange(start, end, weekdayOnly)` filters by date range; weekdayOnly = Mon–Fri only.

## 4. `expectedHours(contract, start, end)` — line 5852 → `src/lib/pay/expected-hours.ts`

```
dayH     = contract === "PT" ? 4 : 8        (anything not "PT" is FT)
weekdays = count of Mon–Fri days in [start, end] inclusive
holidays = weekday-only observed holidays in range
expected = max(0, weekdays*dayH − holidays*dayH)
```
Returns hours (number, not money). Holidays falling Sat/Sun do NOT reduce expected.

## 5. `rateFor(wid)` — line 6160 → `src/lib/pay/rates.ts`

Effective-dated rate resolution against the period:
```
candidates = rates where worker_id = wid
             AND effective_start <= periodEnd
             AND (effective_end IS NULL OR effective_end >= periodStart)
pick the candidate with the LATEST effective_start
```
Legacy returns `Number(amount_php)` (pesos float) or null. New: `Centavos | null`.
String date comparison (ISO) — preserve.

## 6. Core row calculation — `calculate()` line 6076 → `src/lib/pay/calc.ts`

Per contractor, given approved time entries in [start, end]:

```
workedSeconds = Σ (tracked_seconds + pto_seconds)        // paid PTO counts as worked
worked  = workedSeconds / 3600                            // hours
expected = expectedHours(contract, start, end)
ratio   = min(worked / expected, 5)                       // cap 5
gross   = rate == null ? null
        : ratio >= 1 ? rate                               // CAPPED AT RATE — no overtime premium
        : round2(ratio * rate)                            // legacy: +(ratio*rate).toFixed(2)
ded     = rate == null ? 0 : round2(rate − gross)         // informational shortfall, NOT in net
ha      = (includeHA && health_allowance_eligible) ? healthAllowance(hire, start, end) : 0
t13     = (include13 && thirteenth_month_eligible && rate != null)
        ? thirteenthAccrual(rate, hire, end) : 0
pdd     = 0   // manual per-period add-on (PDD lunch), entered in UI
bonus   = 0   // manual, entered in UI
misc    = Σ misc_items: kind "deduction" subtracts (amount stored positive), others add
net     = gross == null ? null : round2(gross + ha + t13 + pdd + bonus + misc)
usd_ref = net == null || !fx ? null : round2(net / fx)    // reference only
```

Worker attribution: time rows with null `worker_id` resolve via `source_name` →
hubstaff_name / "first last" map (incl. `normName` normalization). Unresolved rows and
workers without a `worker_companies` link in the company are surfaced as dropped, never
silently discarded. (Attribution is data-layer, Phase 2 — but the dropped-rows invariant
must carry over.)

Rounding: legacy `round2 = +(x).toFixed(2)` on **pesos floats** (string round-trip,
~half-away-from-zero with binary-float noise). New: integer centavos with
`roundHalfAwayFromZero` (`mulRatioMinor`). Parity tests on real data must confirm; any
±1-centavo divergence is a legacy float bug being fixed (handoff rule 3) — document each.

## 7. `healthAllowance(hire, ps, pe)` — line 5864 → `src/lib/pay/allowances.ts`

Fixed ₱20,000/yr, paid ONCE in the period containing the hire anniversary:
```
if no hire date → 0
elig = hire + 180 days (ms arithmetic)
if periodEnd < elig → 0
anniv = Date(year(periodStart), month(hire), min(day(hire), 28))   // clamp day to 28
if periodStart <= anniv <= periodEnd AND anniv >= elig → 20000 else 0
```

## 8. 13th month — lines 5880–5894 → `src/lib/pay/allowances.ts`

```
monthsWorkedInYear(hire, periodEnd):
  from = Jan 1 of periodEnd's year, or hire if later AND same year
  months = wholeMonthDiff(from, end) + (day(end) − day(from)) / 30   // partial via /30
  clamp to [0, 12]

thirteenthAccrual(ratePhp, hire, periodEnd):
  rate falsy → 0
  round2((monthsWorked / 12) × ratePhp)
```
Semantics: monthly salary = 2 × per-period rate; full 13th = (mw/12) × monthly; this
function returns HALF of the full annual 13th (it's paid across two periods).
The `/30` partial-month and ms-based date math are quirks to preserve exactly (parity),
not "fix".

## 9. `resolvePeriod()` — line 6451 (and `saveDraft`/`lockAndSave` persistence)

Lookup `pay_periods` by (company_id, period_start, period_end) → {id, state}.
States: `open` → `locked` (lock sets locked_at) → `paid`. Draft saves are blocked unless
state = 'open'; lock blocks rows with no rate; net==null rows are never persisted.
Persisted payment columns: expected_hours, worked_hours, performance_ratio (4 dp),
rate_php, gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php,
bonus_php, deduction_php, net_php, misc_items (jsonb), fx_rate, payout_currency='PHP',
payout_amount=net, payout_method, status.

## 10. Rate persistence — `upsertRate` 1919 / `saveRate` 3189 → `src/lib/pay/rates.ts` + server action

Effective-dated, three-step invariant (prevents duplicate-day rows):
1. Same (worker, company, effective_start) row exists → UPDATE amount, set effective_end NULL.
2. Else close open earlier rates: `SET effective_end = newEff WHERE effective_end IS NULL
   AND effective_start < newEff` (never closes future-dated rates — CHECK effective_end >= effective_start).
3. INSERT new row, `period_basis = 'semi_monthly'`.

## 11. `calcBatch(b)` — line 6626

UI trigger only: sets period dates + recalc flag, then `calculate()` runs for that batch's
period. No separate math. New app: batch = map over periods calling the same pure engine.

## Module plan

| Module | Functions | Money type |
|---|---|---|
| `src/lib/money/` | copied from NPM-Helper-App verbatim | Centavos/Cents |
| `src/lib/dates/periods.ts` | periodFor, periodDates, CalendarDate helpers | — |
| `src/lib/pay/holidays.ts` | defaultHolidays, holidaysInRange, easter | — |
| `src/lib/pay/expected-hours.ts` | expectedHours | hours: number |
| `src/lib/pay/rates.ts` | resolveRate (pure), rate upsert plan (pure → server action) | Centavos |
| `src/lib/pay/allowances.ts` | healthAllowance, monthsWorkedInYear, thirteenthAccrual | Centavos |
| `src/lib/pay/calc.ts` | calcContractorRow (pure), miscTotal, recalcNet | Centavos |

All pure: inputs are plain typed data (no DB calls inside). DB mapping lives in
`src/lib/payroll/` mappers + `src/db/` per ADR-0012/0003.

## Parity oracle

Seed Vitest fixtures from real locked/paid periods (read-only SELECT from prod
`payments` + `rates` + `time_entries` + `worker_companies`): re-run the engine on the
stored inputs and require `net_php` (×100 → centavos) to match for every row.
