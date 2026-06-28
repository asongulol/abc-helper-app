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
  addMinor,
  type Centavos,
  type Cents,
  centavos,
  majorToMinor,
  mulRatioMinor,
  roundHalfAwayFromZero,
  subMinor,
  zeroCentavos,
} from '@/lib/money';
import { healthAllowance, thirteenthAccrual } from '@/lib/pay/allowances';
import { type Contract, expectedHours, payModelFor } from '@/lib/pay/expected-hours';
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
  /** Σ approved session units in the period — used for per-session pay. */
  sessionUnits?: number;
  contract: Contract;
  /**
   * worker_companies.pay_basis — the per-unit discriminator for a `PHS`
   * engagement ('hourly' | 'per_session'). Ignored for FT/PT and the legacy
   * PH/PS contracts (whose unit is implied by the contract itself). A PHS
   * engagement with a missing/invalid basis is paid nothing (see PayModel).
   */
  payBasis?: string | null;
  periodStart: string;
  periodEnd: string;
  /** Resolved per-period rate (see resolveRate), or null when the worker has none. */
  rate: Centavos | null;
  /**
   * PH/PS only (F4): a date-aware gross precomputed by the data layer when a
   * per-unit rate change lands mid-period, so units worked before the change
   * are priced at the old rate and units after at the new rate. When supplied
   * it REPLACES the naive `rate × totalUnits` product. Omit (undefined) for the
   * common single-rate case — the engine then computes gross exactly as before
   * (parity). `rate` still carries the latest period rate for display.
   */
  perUnitGrossOverride?: Centavos | null;
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
  /**
   * Off-cycle per-session/per-hour earnings for this worker in the period — a
   * snapshot total re-applied from the durable off_cycle_pay_items ledger (NOT
   * re-priced here). Defaults to 0, so it is a no-op for every fresh calculate
   * and every parity fixture. Added LAST to net (integer-centavos sum is
   * associative, so parity is byte-for-byte unchanged when this is 0).
   */
  offCycleEarnings?: Centavos;
  /** Observed holidays; defaults to the standard list for the period's years. */
  holidays?: readonly Holiday[];
};

export type ContractorRowResult = {
  workedHours: number;
  expectedHours: number;
  /** worked / expected, capped at RATIO_CAP. 0 when nothing worked (and for PH/PS). */
  ratio: number;
  /** The resolved rate used: per-period (FT/PT) or per-unit (PH/PS). */
  rate: Centavos | null;
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
  /** Off-cycle per-session/per-hour earnings (ledger snapshot); 0 by default. */
  offCycle: Centavos;
  net: Centavos | null;
  /**
   * True when this is a `PHS` engagement with a missing/invalid pay_basis, so
   * gross/net were forced null (unpayable) rather than guessed. Lets the UI flag
   * "set the pay basis" instead of silently dropping the row.
   */
  payBasisUnset: boolean;
  /**
   * Approved session count for a per_session row (parity with payments.units);
   * null for per_hour / salaried / unset (their quantity lives in workedHours).
   */
  units: number | null;
};

/** One contractor's pay statement for a period. */
export const calcContractorRow = (input: ContractorRowInput): ContractorRowResult => {
  const worked = input.workedSeconds / 3600;
  const rate = input.rate;

  // Per-unit (no expected hours, no performance ratio): gross is the per-unit
  // rate × units in the period — hours for per_hour, approved sessions for
  // per_session. FT/PT keep the ratio model below, byte-for-byte (parity).
  // `unset` is a PHS engagement with no/invalid pay_basis: pay NOTHING (gross
  // null) rather than risk paying a per-session rate by the hour.
  const model = payModelFor(input.contract, input.payBasis);
  const perUnit = model === 'per_hour' || model === 'per_session';
  const payBasisUnset = model === 'unset';

  let expected: number;
  let ratio: number;
  let gross: Centavos | null;
  let shortfall: Centavos;
  if (payBasisUnset) {
    expected = 0;
    ratio = 0;
    gross = null; // safety: a PHS row with no pay_basis is never payable
    shortfall = zeroCentavos();
  } else if (perUnit) {
    expected = 0;
    ratio = 0;
    const units = model === 'per_hour' ? worked : (input.sessionUnits ?? 0);
    // F4: prefer the date-aware gross when the data layer supplied one (a
    // mid-period rate change); otherwise the naive single-rate product (parity).
    gross =
      rate === null
        ? null
        : input.perUnitGrossOverride !== undefined
          ? input.perUnitGrossOverride
          : mulRatioMinor(rate, units);
    shortfall = zeroCentavos();
  } else {
    expected = expectedHours(input.contract, input.periodStart, input.periodEnd, input.holidays);
    // Legacy: Math.min(worked/expected, 5). Guard expected=0: positive work ⇒
    // capped ratio (legacy Infinity→cap); no work ⇒ 0 (legacy NaN — degenerate).
    ratio = expected > 0 ? Math.min(worked / expected, RATIO_CAP) : worked > 0 ? RATIO_CAP : 0;
    gross = rate === null ? null : ratio >= 1 ? rate : mulRatioMinor(rate, ratio);
    shortfall = rate === null || gross === null ? zeroCentavos() : subMinor(rate, gross);
  }

  const ha =
    (input.includeHealthAllowance ?? true) && input.healthAllowanceEligible
      ? healthAllowance(input.hireDate, input.periodStart, input.periodEnd)
      : zeroCentavos();
  // 13th-month accrues on a salaried period rate only — never for a per-unit
  // (or unset) PHS/PH/PS engagement, whose rate is not a monthly salary.
  const t13 =
    (input.includeThirteenth ?? true) &&
    input.thirteenthMonthEligible &&
    rate !== null &&
    model === 'salaried'
      ? thirteenthAccrual(rate, input.hireDate, input.periodEnd)
      : zeroCentavos();

  const pdd = input.pddLunch ?? zeroCentavos();
  const bonus = input.bonus ?? zeroCentavos();
  const misc = miscTotal(input.miscItems);
  const offCycleRaw = input.offCycleEarnings ?? zeroCentavos();
  // Per-unit workers (per_hour / per_session): the off-cycle ledger total IS
  // their session/hour gross — sessions added to this batch regardless of their
  // date — so fold it into gross. The row then reads as gross (the natural pay
  // for a session/hour contractor) instead of a confusing gross-0 + separate
  // "off-cycle" line. Salaried off-cycle stays its own line (gross is a salary).
  // Net is unchanged either way (same integer-centavos sum).
  if (perUnit && gross !== null && offCycleRaw !== 0) {
    gross = addMinor(gross, offCycleRaw);
  }
  const offCycle = perUnit ? zeroCentavos() : offCycleRaw;

  const net =
    gross === null
      ? null
      : addMinor(
          addMinor(addMinor(addMinor(addMinor(addMinor(gross, ha), t13), pdd), bonus), misc),
          offCycle,
        );

  return {
    workedHours: worked,
    expectedHours: expected,
    ratio,
    rate,
    gross,
    shortfall,
    healthAllowance: ha,
    thirteenth: t13,
    pddLunch: pdd,
    bonus,
    misc,
    offCycle,
    net,
    payBasisUnset,
    // Parity with the originals' payments.units: the approved session COUNT for a
    // per_session row, null otherwise (per_hour keeps its quantity in workedHours).
    units: model === 'per_session' ? (input.sessionUnits ?? 0) : null,
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
