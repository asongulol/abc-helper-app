/**
 * Effective-dated rate resolution, ported from `rateFor` (app/index.html ~6160)
 * and the rate-persistence invariant of `upsertRate`/`saveRate` (~1919/~3189).
 *
 * Rates are per-period (semi-monthly) PHP amounts with [effective_start,
 * effective_end] validity; an open rate has effective_end = null.
 */

import { isoToUtcMs, utcMsToIso } from '@/lib/dates/periods';
import { type Centavos, centavos, majorToMinor } from '@/lib/money';

const DAY_MS = 86_400_000;

/** The ISO date one day before `date` (UTC-day based). */
const dayBefore = (date: string): string => utcMsToIso(isoToUtcMs(date) - DAY_MS);

export type RateRow = {
  workerId: string;
  /** DB numeric(12,2) arrives as string or number — converted at this boundary. */
  amountPhp: number | string;
  effectiveStart: string;
  effectiveEnd: string | null;
};

/**
 * The rate applicable to a period: candidates overlap the period
 * (effective_start <= periodEnd AND (effective_end IS NULL OR
 * effective_end >= periodStart)); the most recent effective_start wins.
 * Returns null when the worker has no applicable rate.
 */
export const resolveRate = (
  rates: readonly RateRow[],
  workerId: string,
  periodStart: string,
  periodEnd: string,
): Centavos | null => {
  let best: RateRow | null = null;
  for (const r of rates) {
    if (r.workerId !== workerId) continue;
    if (r.effectiveStart > periodEnd) continue;
    if (r.effectiveEnd !== null && r.effectiveEnd < periodStart) continue;
    if (best === null || r.effectiveStart > best.effectiveStart) best = r;
  }
  if (best === null) return null;
  return centavos(majorToMinor(Number(best.amountPhp)));
};

/** A planned write for an effective-dated rate change (executed by the data layer). */
export type RateUpsertPlan =
  | {
      kind: 'same-day-update';
      rateId: string;
      amountPhp: number;
      effectiveStart: string;
    }
  | {
      kind: 'close-and-insert';
      closeBefore: string;
      amountPhp: number;
      effectiveStart: string;
    };

/**
 * Pure planning step for the legacy 3-step rate save:
 *  1. a row with the SAME effective_start exists → update it in place (same-day
 *     saves replace, never stack — prevents duplicate-day rows);
 *  2. otherwise close any open rate whose effective_start is STRICTLY before
 *     the new date (never retro-close a future-dated rate), then
 *  3. insert the new rate (period_basis 'semi_monthly').
 *
 * F9: the prior rate is closed at `effectiveStart − 1 day` (exclusive), so the
 * old and new rows never both cover the boundary day. resolveRate's
 * effective_end test is inclusive (>= periodStart), so the old rate still
 * covers up to and including its last day.
 */
export const planRateUpsert = (
  existing: readonly {
    id: string;
    effectiveStart: string;
    effectiveEnd: string | null;
  }[],
  amountPhp: number,
  effectiveStart: string,
): RateUpsertPlan => {
  const sameDay = existing.find((r) => r.effectiveStart === effectiveStart);
  if (sameDay)
    return {
      kind: 'same-day-update',
      rateId: sameDay.id,
      amountPhp,
      effectiveStart,
    };
  return {
    kind: 'close-and-insert',
    closeBefore: dayBefore(effectiveStart),
    amountPhp,
    effectiveStart,
  };
};
