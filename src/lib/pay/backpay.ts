/**
 * Contract backpay — what a period already PAID at the old rate is still owed
 * once a contract version takes effect earlier than the day it was countersigned
 * (docs/CONTRACT-VERSIONS-PLAN.md slice 4b). Pure; the ledger service maps rows
 * onto it.
 */

import { weekdayCount } from '@/lib/dates/periods';
import { type Centavos, clampNonNegative, mulRatioMinor } from '@/lib/money';

export type BackpayProration = {
  /** Working days of the period on or after the effective date. */
  coveredDays: number;
  /** Working days in the whole period. */
  totalDays: number;
  fraction: number;
};

/**
 * Owner decision (2026-09-04): the first period is prorated by WORKING days on
 * or after the effective date — unlike the engine, which prices a whole period
 * at the winning rate. ponytail: weekdays only, holidays not subtracted; use
 * expectedHours() here if the owner wants the holiday-adjusted denominator.
 */
export const prorationFor = (
  periodStart: string,
  periodEnd: string,
  effectiveFrom: string,
): BackpayProration => {
  const totalDays = weekdayCount(periodStart, periodEnd);
  const from = effectiveFrom > periodStart ? effectiveFrom : periodStart;
  const coveredDays = from > periodEnd ? 0 : weekdayCount(from, periodEnd);
  return { coveredDays, totalDays, fraction: totalDays > 0 ? coveredDays / totalDays : 0 };
};

/**
 * paid × (new − old) / old × fraction. For a salaried row this is exactly the
 * engine's (new − old) × min(ratio, 1), because gross = rate × min(ratio, 1);
 * for a per-unit row it is (new − old) × units — and it needs no ratio column,
 * so legacy rows (rate + gross only) price too. Never negative: a rate that
 * went down is not clawed back.
 */
export const backpayForPaid = (args: {
  paid: Centavos;
  oldRate: Centavos;
  newRate: Centavos;
  proration: BackpayProration;
}): Centavos => {
  if (args.oldRate <= 0) return clampNonNegative(0 as Centavos);
  const uplift = (args.newRate - args.oldRate) / args.oldRate;
  return clampNonNegative(mulRatioMinor(args.paid, uplift * args.proration.fraction));
};
