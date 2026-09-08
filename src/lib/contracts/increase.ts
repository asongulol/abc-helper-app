/**
 * The wizard's Increase step (docs/CONTRACT-CHANGE-WIZARD-PLAN.md decision 4):
 * percent, flat peso or exact, all on the semi-monthly figure. Pure — the
 * wizard previews with it, the schema checks the submitted detail against it,
 * and the history line is written from it.
 */

export const INCREASE_METHODS = ['percent', 'flat', 'exact'] as const;
export type IncreaseMethod = (typeof INCREASE_METHODS)[number];

export type IncreaseDetail = {
  method: IncreaseMethod;
  /** The percent, the peso amount, or the exact rate — as typed. */
  value: number;
  /** The base the admin picked; null when the record has no rate yet. */
  from: number | null;
  to: number;
  base: 'record' | 'live';
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The resulting semi-monthly rate, or null when it cannot be computed (no base
 * for a relative change, or nothing typed). Percent rounds to the nearest peso.
 */
export const applyIncrease = (
  method: IncreaseMethod,
  value: number,
  from: number | null,
): number | null => {
  if (!Number.isFinite(value)) return null;
  if (method === 'exact') return round2(value);
  if (from == null) return null;
  return method === 'percent' ? Math.round(from * (1 + value / 100)) : round2(from + value);
};

const fmt = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** "+5%" / "−500"; null for an exact rate, which has no "how". */
export const increaseHow = (d: IncreaseDetail): string | null => {
  if (d.method === 'exact') return null;
  const sign = d.value < 0 ? '−' : '+';
  return `${sign}${fmt(Math.abs(d.value))}${d.method === 'percent' ? '%' : ''}`;
};

/** "+5% · 8,000 → 8,400" for the history line; null when the rate did not move. */
export const describeIncrease = (d: IncreaseDetail): string | null => {
  if (d.from == null || d.from === d.to) return null;
  return [increaseHow(d), `${fmt(d.from)} → ${fmt(d.to)}`].filter(Boolean).join(' · ');
};
