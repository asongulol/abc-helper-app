/**
 * Semi-monthly pay periods (arrears), ported from the legacy app's
 * `periodFor` / `periodDates` (app/index.html ~5901 / ~5337).
 *
 * Pay rule: days 1–15 are paid at the END of the SAME month; days 16–EOM are
 * paid on the 15th of the NEXT month.
 *
 * All date math is UTC-day based on ISO `YYYY-MM-DD` strings — no timezones,
 * no DST artifacts (the legacy app mixed local and UTC constructors; this is
 * the documented fix, see docs/money-core-spec.md §1).
 */

export type PayPeriod = {
  start: string;
  end: string;
  /** Arrears pay date for the period. */
  payDate: string;
};

const DAY_MS = 86_400_000;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Build an ISO date from 1-based year/month/day. */
export const isoDate = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;

/** Parse `YYYY-MM-DD` into numeric parts. Throws on malformed input. */
export const parseIso = (dateStr: string): { y: number; m: number; d: number } => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) throw new Error(`Invalid ISO date: ${dateStr}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
};

/** UTC timestamp (ms) for an ISO date at 00:00:00Z. */
export const isoToUtcMs = (dateStr: string): number => {
  const { y, m, d } = parseIso(dateStr);
  return Date.UTC(y, m - 1, d);
};

/** ISO date for a UTC timestamp. */
export const utcMsToIso = (ms: number): string => {
  const dt = new Date(ms);
  return isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
};

/** Last day number of a (1-based) month. */
export const lastDayOfMonth = (y: number, m: number): number =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();

/** ISO weekday check: Monday–Friday. */
export const isWeekday = (dateStr: string): boolean => {
  const wd = new Date(isoToUtcMs(dateStr)).getUTCDay();
  return wd >= 1 && wd <= 5;
};

/** The semi-monthly period containing `dateStr`, with its arrears pay date. */
export const periodFor = (dateStr: string): PayPeriod => {
  const { y, m, d } = parseIso(dateStr);
  if (d <= 15) {
    return {
      start: isoDate(y, m, 1),
      end: isoDate(y, m, 15),
      payDate: isoDate(y, m, lastDayOfMonth(y, m)),
    };
  }
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return {
    start: isoDate(y, m, 16),
    end: isoDate(y, m, lastDayOfMonth(y, m)),
    payDate: isoDate(nextY, nextM, 15),
  };
};

/** Every ISO date from `start` to `end` inclusive. */
export const periodDates = (start: string, end: string): string[] => {
  const out: string[] = [];
  const endMs = isoToUtcMs(end);
  for (let ms = isoToUtcMs(start); ms <= endMs; ms += DAY_MS) out.push(utcMsToIso(ms));
  return out;
};

/** Count of Monday–Friday days in [start, end] inclusive. */
export const weekdayCount = (start: string, end: string): number => {
  let n = 0;
  const endMs = isoToUtcMs(end);
  for (let ms = isoToUtcMs(start); ms <= endMs; ms += DAY_MS) {
    const wd = new Date(ms).getUTCDay();
    if (wd >= 1 && wd <= 5) n++;
  }
  return n;
};
