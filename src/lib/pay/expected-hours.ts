/**
 * Expected hours for a pay period, ported from `expectedHours`
 * (app/index.html ~5852).
 *
 * Expected = (Mon–Fri days in period × day-hours) − (day-hours per observed
 * holiday landing on a weekday). Day-hours: 8 full-time / 4 part-time.
 */

import { weekdayCount } from '@/lib/dates/periods';
import { defaultHolidaysForRange, type Holiday, holidaysInRange } from '@/lib/pay/holidays';

export const FT_DAY_HOURS = 8;
export const PT_DAY_HOURS = 4;

/**
 * Contract type. FT/PT are salaried (expected day-hours drive the performance
 * ratio). PHS (per hour / session — the shared-prod model) and the legacy
 * PH/PS have NO expected hours — they are paid per unit (see calc.ts) and
 * resolve to 0 day-hours here. Legacy rule: anything that isn't PT/PH/PS/PHS
 * counts as FT.
 */
export type Contract = 'FT' | 'PT' | 'PH' | 'PS' | 'PHS' | (string & {});

export const dayHoursFor = (contract: Contract): number =>
  contract === 'PT'
    ? PT_DAY_HOURS
    : contract === 'PH' || contract === 'PS' || contract === 'PHS'
      ? 0
      : FT_DAY_HOURS;

/**
 * How a contractor is paid, normalised from (contract, pay_basis).
 * - `salaried`     — FT/PT: expected-hours performance ratio × period rate.
 * - `per_hour`     — legacy `PH`, or shared-prod `PHS` + pay_basis='hourly':
 *                    worked hours × per-hour rate.
 * - `per_session`  — legacy `PS`, or `PHS` + pay_basis='per_session':
 *                    approved sessions × per-session rate.
 * - `unset`        — a `PHS` engagement whose pay_basis is missing/invalid.
 *                    SAFETY STATE: never silently pay worked×rate (that would
 *                    turn a per-session rate into an hourly one). The engine
 *                    produces a null gross so the row can't be locked/paid.
 *
 * The originals consolidated per-hour/per-session into one `PHS` + a pay_basis
 * discriminator; this app's own older rows still use separate `PH`/`PS`. Both
 * map to the same three real behaviours here.
 */
export type PayModel = 'salaried' | 'per_hour' | 'per_session' | 'unset';

export const payModelFor = (contract: Contract, payBasis?: string | null): PayModel => {
  if (contract === 'PH') return 'per_hour';
  if (contract === 'PS') return 'per_session';
  if (contract === 'PHS') {
    if (payBasis === 'hourly') return 'per_hour';
    if (payBasis === 'per_session') return 'per_session';
    return 'unset';
  }
  return 'salaried';
};

/**
 * Expected working hours in [start, end] for the contract type.
 * `holidays` defaults to the offices' standard list for the years in range.
 */
export const expectedHours = (
  contract: Contract,
  start: string,
  end: string,
  holidays?: readonly Holiday[],
): number => {
  const dayH = dayHoursFor(contract);
  const weekdays = weekdayCount(start, end);
  const observed = holidaysInRange(
    holidays ?? defaultHolidaysForRange(start, end),
    start,
    end,
    true,
  ).length;
  return Math.max(0, weekdays * dayH - observed * dayH);
};
