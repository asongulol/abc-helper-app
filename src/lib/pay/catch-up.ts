import { type Centavos, clampNonNegative, mulRatioMinor, subMinor } from '@/lib/money';

/**
 * Gross the FT/PT engine pays for `hours` against `expected` at `rate`, with the
 * strict cap: gross depends only on min(hours/expected, 1) — identical to the
 * salaried branch in calc.ts (its RATIO_CAP=5 never changes gross above 1).
 * expected=0 mirrors the engine's degenerate branch: any positive hours ⇒ full
 * rate; none ⇒ 0.
 */
const cappedGross = (rate: Centavos, hours: number, expected: number): Centavos => {
  const ratio = expected > 0 ? Math.min(hours / expected, 1) : hours > 0 ? 1 : 0;
  return ratio >= 1 ? rate : mulRatioMinor(rate, ratio);
};

/**
 * Incremental amount owed for catching up `leftoverHours` on the ORIGINAL
 * locked/paid period: rate × (min((paid+caught+leftover)/expected, 1) −
 * min((paid+caught)/expected, 1)), each side rounded exactly like the engine's
 * gross so before + amount === after to the centavo. Hours beyond 100% of
 * expected pay ₱0 (strict engine cap — a regular run would not have paid them).
 * Returns null when the worker has no rate for that period.
 */
export const salariedCatchUpAmount = (args: {
  rate: Centavos | null;
  expectedHours: number;
  paidHours: number;
  caughtUpHours: number;
  leftoverHours: number;
}): Centavos | null => {
  if (args.rate === null) return null;
  const base = args.paidHours + args.caughtUpHours;
  return clampNonNegative(
    subMinor(
      cappedGross(args.rate, base + args.leftoverHours, args.expectedHours),
      cappedGross(args.rate, base, args.expectedHours),
    ),
  );
};
