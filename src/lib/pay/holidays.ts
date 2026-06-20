/**
 * Observed-holiday engine, ported from the legacy app (app/index.html ~5809–5862).
 *
 * Each observed holiday that lands on a weekday reduces expected hours by one
 * working day (8h FT / 4h PT). The legacy app allowed per-year overrides in
 * localStorage; here the holiday list is a plain value so the engine stays
 * pure — persistence of overrides is a later (data-layer) concern.
 *
 * Weekend observance (legacy `_observed`): a holiday that lands on a weekend is
 * shifted to the closest working day — Saturday → the Friday before, Sunday →
 * the Monday after (1 day away vs. 2) — so it still reduces expected work.
 *
 * All computations are UTC-day based.
 */

import { isoDate, isoToUtcMs } from '@/lib/dates/periods';

export type Holiday = { name: string; date: string };

/** UTC date for the n-th weekday `wd` (0=Sun..6=Sat) of month `m` (0-based). */
const nthWeekday = (y: number, m: number, wd: number, n: number): Date => {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return new Date(Date.UTC(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7));
};

/** UTC date for the LAST weekday `wd` of month `m` (0-based). */
const lastWeekday = (y: number, m: number, wd: number): Date => {
  const last = new Date(Date.UTC(y, m + 1, 0));
  return new Date(Date.UTC(y, m, last.getUTCDate() - ((last.getUTCDay() - wd + 7) % 7)));
};

/** Gregorian Easter Sunday (anonymous algorithm), as a UTC date. */
const easter = (y: number): Date => {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * mm + 114) / 31);
  const da = ((h + l - 7 * mm + 114) % 31) + 1;
  return new Date(Date.UTC(y, mo - 1, da));
};

const isoOfUtc = (dt: Date): string =>
  isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());

const addDays = (dt: Date, days: number): Date => new Date(dt.getTime() + days * 86_400_000);

/**
 * Shift a date that lands on a weekend to the nearest working day (US
 * observance): Saturday → the Friday before, Sunday → the Monday after. Both
 * are the closest weekday (1 day away vs. 2). Weekdays pass through unchanged.
 */
const observedUtc = (dt: Date): Date => {
  const wd = dt.getUTCDay();
  if (wd === 6) return addDays(dt, -1); // Sat → Fri
  if (wd === 0) return addDays(dt, 1); // Sun → Mon
  return dt;
};

/** The observed working-day (ISO) for a holiday date — see {@link observedUtc}. */
export const observedDate = (date: string): string =>
  isoOfUtc(observedUtc(new Date(isoToUtcMs(date))));

/**
 * The offices' default observed-holiday list for a year. Fixed-date holidays
 * (New Year's, Independence, Christmas) are shifted to the nearest working day
 * when they land on a weekend; the floating ones already resolve to a weekday.
 */
export const defaultHolidays = (year: number): Holiday[] => {
  const easterSunday = easter(year);
  const goodFriday = addDays(easterSunday, -2);
  const thanksgiving = nthWeekday(year, 10, 4, 4);
  return [
    { name: "New Year's Day", date: isoOfUtc(observedUtc(new Date(Date.UTC(year, 0, 1)))) },
    {
      name: 'Martin Luther King Jr. Day',
      date: isoOfUtc(nthWeekday(year, 0, 1, 3)),
    },
    { name: 'Good Friday', date: isoOfUtc(goodFriday) },
    { name: 'Memorial Day', date: isoOfUtc(lastWeekday(year, 4, 1)) },
    { name: 'Independence Day', date: isoOfUtc(observedUtc(new Date(Date.UTC(year, 6, 4)))) },
    { name: 'Labor Day', date: isoOfUtc(nthWeekday(year, 8, 1, 1)) },
    {
      name: "Indigenous Peoples' Day",
      date: isoOfUtc(nthWeekday(year, 9, 1, 2)),
    },
    { name: 'Thanksgiving Day', date: isoOfUtc(thanksgiving) },
    {
      name: 'Day after Thanksgiving',
      date: isoOfUtc(addDays(thanksgiving, 1)),
    },
    { name: 'Christmas Day', date: isoOfUtc(observedUtc(new Date(Date.UTC(year, 11, 25)))) },
  ];
};

/**
 * Default holidays for every year touched by [start, end], plus the adjacent
 * years: a weekend observance can move a holiday across the year boundary (New
 * Year's Day on a Saturday is observed on Dec 31 of the prior year), so the
 * window's caller must see those neighbours too.
 */
export const defaultHolidaysForRange = (start: string, end: string): Holiday[] => {
  const ys = Number(start.slice(0, 4));
  const ye = Number(end.slice(0, 4));
  const all: Holiday[] = [];
  for (let y = ys - 1; y <= ye + 1; y++) all.push(...defaultHolidays(y));
  return all;
};

/**
 * Holidays within [start, end] inclusive.
 *
 * With `weekdayOnly` (the expected-hours path), each holiday is first shifted to
 * its observed working day so a weekend-landing holiday still reduces expected
 * work; the result is deduped by observed date so two holidays sharing one
 * working day only count once. Without it, holidays are returned by their
 * literal date (display path).
 */
export const holidaysInRange = (
  holidays: readonly Holiday[],
  start: string,
  end: string,
  weekdayOnly: boolean,
): Holiday[] => {
  if (!weekdayOnly) {
    return holidays.filter((h) => h.date >= start && h.date <= end);
  }
  const seen = new Set<string>();
  const out: Holiday[] = [];
  for (const h of holidays) {
    const date = observedDate(h.date);
    if (date < start || date > end || seen.has(date)) continue;
    seen.add(date);
    out.push({ ...h, date });
  }
  return out;
};
