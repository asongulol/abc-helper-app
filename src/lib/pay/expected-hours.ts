/**
 * Expected hours for a pay period, ported from `expectedHours`
 * (app/index.html ~5852).
 *
 * Expected = (Mon–Fri days in period × day-hours) − (day-hours per observed
 * holiday landing on a weekday). Day-hours: 8 full-time / 4 part-time.
 */

import { weekdayCount } from '@/lib/dates/periods';
import { type Holiday, defaultHolidaysForRange, holidaysInRange } from '@/lib/pay/holidays';

export const FT_DAY_HOURS = 8;
export const PT_DAY_HOURS = 4;

/** Contract type. Legacy rule: anything that isn't exactly "PT" counts as FT. */
export type Contract = 'FT' | 'PT' | (string & {});

export const dayHoursFor = (contract: Contract): number =>
  contract === 'PT' ? PT_DAY_HOURS : FT_DAY_HOURS;

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
