/**
 * Core per-contractor payroll calculation, ported from `calculate()`
 * (app/index.html ~6076) and the row helpers `miscTotal`/`recalcNet` (~6369).
 *
 * Pure: all inputs arrive as plain data; DB fetching/attribution lives in the
 * data layer. Money is integer centavos throughout (ADR-0006); the legacy
 * float + `toFixed(2)` rounding is replaced by half-away-from-zero integer
 * rounding, validated by parity tests against real historical periods.
 */

import {
  type Centavos,
  type Cents,
  addMinor,
  centavos,
  majorToMinor,
  mulRatioMinor,
  roundHalfAwayFromZero,
  subMinor,
  zeroCentavos,
} from '@/lib/money';
import { healthAllowance, thirteenthAccrual } from '@/lib/pay/allowances';
import { type Contract, expectedHours } from '@/lib/pay/expected-hours';
import type { Holiday } from '@/lib/pay/holidays';

/** Performance-ratio cap ("matches workbook V"). */
export const RATIO_CAP = 5;

/** A per-period manual adjustment line. Amounts are PHP major units in stored data. */
export type MiscItem = {
  kind: 'other_earns' | 'other_hours' | 'deduction' | (string & {});
  label?: string;
  amount?: number | string | null;
  hours?: number | string | null;
};

/**
 * Net effect of misc items in centavos: `deduction` kind subtracts (amount is
 * stored positive), every other kind adds. Non-numeric amounts count as 0.
 */
export const miscTotal = (items: readonly MiscItem[] | null | undefined): Centavos => {
  if (!Array.isArray(items)) return zeroCentavos();
  let total = 0;
  for (const it of items) {
    const minor = majorToMinor(Number(it?.amount) || 0);
    total += it?.kind === 'deduction' ? -minor : minor;
  }
  return centavos(total);
};

export type ContractorRowInput = {
  /** Σ (tracked_seconds + pto_seconds) over approved entries in the period. */
  workedSeconds: number;
  contract: Contract;
  periodStart: string;
  periodEnd: string;
  /** Resolved per-period rate (see resolveRate), or null when the worker has none. */
  rate: Centavos | null;
  hireDate?: string | null;
  healthAllowanceEligible?: boolean;
  thirteenthMonthEligible?: boolean;
  /** Batch-level toggles (legacy `includeHA` / `include13`). */
  includeHealthAllowance?: boolean;
  includeThirteenth?: boolean;
  /** Manual per-period add-ons (0 on a fresh calculate; edited in the UI). */
  pddLunch?: Centavos;
  bonus?: Centavos;
  miscItems?: readonly MiscItem[];
  /** Observed holidays; defaults to the standard list for the period's years. */
  holidays?: readonly Holiday[];
};

export type ContractorRowResult = {
  workedHours: number;
  expectedHours: number;
  /** worked / expected, capped at RATIO_CAP. 0 when nothing worked. */
  ratio: number;
  /** Capped at the rate — ratio ≥ 1 pays exactly the rate (no overtime premium). */
  gross: Centavos | null;
  /**
   * Performance shortfall (rate − gross). INFORMATIONAL ONLY — it is NOT
   * subtracted from net. Named `shortfall` (not "deduction") deliberately: the
   * legacy `deduction_php` column/label misrepresented this as money withheld.
   * Real, subtracted deductions are misc items with `kind: 'deduction'`.
   */
  shortfall: Centavos;
  healthAllowance: Centavos;
  thirteenth: Centavos;
  pddLunch: Centavos;
  bonus: Centavos;
  misc: Centavos;
  net: Centavos | null;
};

/** One contractor's pay statement for a period. */
export const calcContractorRow = (input: ContractorRowInput): ContractorRowResult => {
  const worked = input.workedSeconds / 3600;
  const expected = expectedHours(
    input.contract,
    input.periodStart,
    input.periodEnd,
    input.holidays,
  );
  // Legacy: Math.min(worked/expected, 5). Guard expected=0: positive work ⇒
  // capped ratio (legacy Infinity→cap); no work ⇒ 0 (legacy NaN — degenerate).
  const ratio = expected > 0 ? Math.min(worked / expected, RATIO_CAP) : worked > 0 ? RATIO_CAP : 0;

  const rate = input.rate;
  const gross = rate === null ? null : ratio >= 1 ? rate : mulRatioMinor(rate, ratio);
  const shortfall = rate === null || gross === null ? zeroCentavos() : subMinor(rate, gross);

  const ha =
    (input.includeHealthAllowance ?? true) && input.healthAllowanceEligible
      ? healthAllowance(input.hireDate, input.periodStart, input.periodEnd)
      : zeroCentavos();
  const t13 =
    (input.includeThirteenth ?? true) && input.thirteenthMonthEligible && rate !== null
      ? thirteenthAccrual(rate, input.hireDate, input.periodEnd)
      : zeroCentavos();

  const pdd = input.pddLunch ?? zeroCentavos();
  const bonus = input.bonus ?? zeroCentavos();
  const misc = miscTotal(input.miscItems);

  const net =
    gross === null
      ? null
      : addMinor(addMinor(addMinor(addMinor(addMinor(gross, ha), t13), pdd), bonus), misc);

  return {
    workedHours: worked,
    expectedHours: expected,
    ratio,
    gross,
    shortfall,
    healthAllowance: ha,
    thirteenth: t13,
    pddLunch: pdd,
    bonus,
    misc,
    net,
  };
};

/**
 * USD reference amount for display (paid in PHP; never used for payouts).
 * `fx` is PHP per 1 USD. Returns USD cents.
 */
export const usdReference = (net: Centavos | null, fx: number): Cents | null => {
  if (net === null || !fx) return null;
  return roundHalfAwayFromZero(net / fx) as Cents;
};
