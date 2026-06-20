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
 * ratio). PH (per hour) / PS (per session) have NO expected hours — they are
 * paid per unit (see calc.ts) and resolve to 0 day-hours here. Legacy rule:
 * anything that isn't PT/PH/PS counts as FT.
 */
export type Contract = 'FT' | 'PT' | 'PH' | 'PS' | (string & {});

export const dayHoursFor = (contract: Contract): number =>
  contract === 'PT' ? PT_DAY_HOURS : contract === 'PH' || contract === 'PS' ? 0 : FT_DAY_HOURS;

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
