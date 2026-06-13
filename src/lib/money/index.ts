/**
 * Money primitives.
 *
 * All monetary values are represented as **integer minor units** (no floats):
 *   - `Cents`    — USD minor unit (1 USD = 100 cents). Used for facility invoices.
 *   - `Centavos` — PHP minor unit (1 PHP = 100 centavos). Used for contractor pay.
 *
 * The two are distinct **branded** types so the compiler rejects accidentally mixing
 * currencies (adding centavos to cents) or passing a raw float where money is expected.
 * This enforces the project rule: "money always in integer cents/Decimal, never raw floats."
 *
 * Conversion to/from the major unit happens only at trust boundaries (DB `numeric(12,2)`,
 * UI display, integration payloads) via the helpers here.
 */

declare const CENTS: unique symbol;
declare const CENTAVOS: unique symbol;

export type Cents = number & { readonly [CENTS]: true };
export type Centavos = number & { readonly [CENTAVOS]: true };

/** Any integer minor-unit money value. */
export type Minor = Cents | Centavos;

class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

const assertSafeInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer minor unit, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} exceeds the safe integer range: ${value}`);
  }
};

/** Construct USD `Cents` from an integer. Throws on non-integer / unsafe input. */
export const cents = (value: number): Cents => {
  assertSafeInteger(value, 'Cents');
  return value as Cents;
};

/** Construct PHP `Centavos` from an integer. Throws on non-integer / unsafe input. */
export const centavos = (value: number): Centavos => {
  assertSafeInteger(value, 'Centavos');
  return value as Centavos;
};

/** Zero of the same brand as `like` (defaults via the explicit constructors below). */
export const zeroCents = (): Cents => 0 as Cents;
export const zeroCentavos = (): Centavos => 0 as Centavos;

/**
 * Round half away from zero (symmetric rounding) to the nearest integer.
 * `Math.round` rounds .5 toward +Infinity, which is asymmetric for negatives; money
 * rounding should be symmetric so that, e.g., -0.5 and 0.5 round to -1 and 1.
 */
export const roundHalfAwayFromZero = (value: number): number =>
  value < 0 ? -Math.round(-value) : Math.round(value);

/** Add two money values of the same currency brand. */
export const addMinor = <T extends Minor>(a: T, b: T): T => (a + b) as T;

/** Subtract two money values of the same currency brand. */
export const subMinor = <T extends Minor>(a: T, b: T): T => (a - b) as T;

/** Sum a list of money values of the same currency brand (empty list → 0). */
export const sumMinor = <T extends Minor>(values: readonly T[]): T =>
  values.reduce((acc, v) => (acc + v) as T, 0 as T);

/** Multiply a money value by a ratio (e.g. a 0..1 proration), rounding to an integer. */
export const mulRatioMinor = <T extends Minor>(amount: T, ratio: number): T =>
  roundHalfAwayFromZero(amount * ratio) as T;

/** Lower bound: never return a negative money value (clamp to 0). */
export const clampNonNegative = <T extends Minor>(amount: T): T => (amount < 0 ? (0 as T) : amount);

/**
 * Allocate a total across buckets in proportion to integer `weights`, returning integer
 * minor units that **sum exactly to `total`** (the last non-zero-weight bucket absorbs the
 * rounding remainder). This is how a bi-monthly rate is split across the (possibly partial)
 * weeks of a pay period without losing or inventing a centavo.
 *
 * @throws if all weights are zero (cannot allocate a non-zero total with no weight).
 */
export const allocateByWeights = <T extends Minor>(total: T, weights: readonly number[]): T[] => {
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);
  if (totalWeight <= 0) {
    if (total === 0) return weights.map(() => 0 as T);
    throw new MoneyError('Cannot allocate a non-zero total across zero total weight');
  }
  const lastWeightedIndex = weights.reduce((last, w, i) => (w > 0 ? i : last), -1);

  const result: T[] = [];
  let allocated = 0;
  for (let i = 0; i < weights.length; i++) {
    if (i === lastWeightedIndex) {
      result.push(((total as number) - allocated) as T);
      continue;
    }
    const share = roundHalfAwayFromZero(((total as number) * (weights[i] ?? 0)) / totalWeight);
    allocated += share;
    result.push(share as T);
  }
  return result;
};

/** Convert a major-unit decimal string/number (e.g. "20000.00") to minor units. */
export const majorToMinor = (major: number): number => roundHalfAwayFromZero(major * 100);

/** Render USD cents as a display string, e.g. `cents(104000)` → "$1,040.00". */
export const formatUsd = (value: Cents): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);

/** Render PHP centavos as a display string, e.g. `centavos(1914000)` → "₱19,140.00". */
export const formatPhp = (value: Centavos): string =>
  new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(value / 100);
