/**
 * Health allowance + 13th-month accrual, ported from app/index.html
 * (~5864 `healthAllowance`, ~5880 `monthsWorkedInYear`, ~5890 `thirteenthAccrual`).
 *
 * NOTE: the legacy app mixed UTC-parsed ISO strings with LOCAL Date
 * constructors, which could shift the hire month/day by one for timezones west
 * of UTC (e.g. a hire date on the 1st). This port is all-UTC — any divergence
 * found by parity tests is that legacy bug being fixed (documented per
 * handoff rule 3 / spec §7).
 */

import { isoToUtcMs, parseIso } from '@/lib/dates/periods';
import { type Centavos, centavos, mulRatioMinor, zeroCentavos } from '@/lib/money';

/** Fixed annual health allowance: ₱20,000. */
export const HA_ANNUAL = centavos(2_000_000);
/** Eligibility: 180 days after hire. */
export const HA_ELIG_DAYS = 180;

const DAY_MS = 86_400_000;

/**
 * Health allowance for a period: the full ₱20,000 is paid in the ONE period
 * containing the hire anniversary (month/day clamped to 28), provided the
 * worker has passed the 180-day eligibility mark by the anniversary.
 */
export const healthAllowance = (
  hireDate: string | null | undefined,
  periodStart: string,
  periodEnd: string,
): Centavos => {
  if (!hireDate) return zeroCentavos();
  const hire = parseIso(hireDate);
  const eligMs = isoToUtcMs(hireDate) + HA_ELIG_DAYS * DAY_MS;
  if (isoToUtcMs(periodEnd) < eligMs) return zeroCentavos();
  const annivMs = Date.UTC(parseIso(periodStart).y, hire.m - 1, Math.min(hire.d, 28));
  const inPeriod = isoToUtcMs(periodStart) <= annivMs && annivMs <= isoToUtcMs(periodEnd);
  return inPeriod && annivMs >= eligMs ? HA_ANNUAL : zeroCentavos();
};

/**
 * Months worked this calendar year through `periodEnd`: from Jan 1 (or the
 * hire date, if later and in the same year), whole months plus a partial month
 * approximated as (dayEnd − dayFrom) / 30 — preserved exactly from legacy.
 * Clamped to [0, 12].
 */
export const monthsWorkedInYear = (
  hireDate: string | null | undefined,
  periodEnd: string,
): number => {
  const end = parseIso(periodEnd);
  let from = { y: end.y, m: 1, d: 1 };
  if (hireDate) {
    const h = parseIso(hireDate);
    if (h.y === end.y && isoToUtcMs(hireDate) > Date.UTC(end.y, 0, 1)) from = h;
  }
  let months = (end.y - from.y) * 12 + (end.m - from.m);
  months += (end.d - from.d) / 30;
  return Math.max(0, Math.min(12, months));
};

/**
 * 13th-month accrual for ONE pay period's statement: (monthsWorked / 12) × the
 * per-period rate. Monthly salary = 2 × per-period rate, the full annual 13th
 * = (mw/12) × monthly, and it's paid across two periods — so this equals HALF
 * the full annual amount. Returns 0 when the rate is null/zero.
 */
export const thirteenthAccrual = (
  rate: Centavos | null,
  hireDate: string | null | undefined,
  periodEnd: string,
): Centavos => {
  if (!rate) return zeroCentavos();
  const mw = monthsWorkedInYear(hireDate, periodEnd);
  return mulRatioMinor(rate, mw / 12);
};
