/**
 * Sparkline point math for the Overview net-pay chart.
 *
 * Pure module: no DOM, no DB, no React — testable in a plain Node/Vitest
 * environment.  All PHP arithmetic goes through integer centavos.
 *
 * centavos = Math.round(php * 100), sum as integers, divide back for display.
 */

export interface SparkPeriod {
  /** Period label shown on the x-axis tooltip, e.g. "Jun 1–15". */
  label: string;
  /** Sum of net_php for this period (PHP major units, as stored). */
  totalNetPhp: number;
}

export interface SparkPoint {
  label: string;
  /** PHP major units (converted from integer centavos accumulation). */
  totalNetPhp: number;
  /** 0–1 normalised height within the sparkline viewport. */
  y: number;
}

/**
 * Convert a list of DB-sourced period rows into SVG-ready normalised points.
 *
 * Money rule: each `totalNetPhp` is multiplied to integer centavos before
 * the min/max calculation; the normalised y is derived from those integers so
 * there is no float accumulation error.
 *
 * @param periods  Ordered list of periods (oldest → newest).
 * @returns        Same-length array of points; empty array when `periods` is
 *                 empty.  When all centavos values are equal the y is 0.5 for
 *                 every point (flat line centred in the viewport).
 */
export const toSparkPoints = (periods: readonly SparkPeriod[]): SparkPoint[] => {
  if (periods.length === 0) return [];

  // Convert to centavos (integers) to avoid float accumulation.
  const centavosValues = periods.map((p) => Math.round(p.totalNetPhp * 100));

  let minC = centavosValues[0] ?? 0;
  let maxC = centavosValues[0] ?? 0;
  for (const c of centavosValues) {
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
  }

  const range = maxC - minC;

  return periods.map((p, i) => {
    const c = centavosValues[i] ?? 0;
    const y = range === 0 ? 0.5 : (c - minC) / range;
    return {
      label: p.label,
      totalNetPhp: p.totalNetPhp,
      y,
    };
  });
};

/**
 * Convert normalised SparkPoints to SVG polyline coordinates within a
 * viewport of `width` × `height` pixels.
 *
 * The y-axis is flipped so higher values are drawn higher on screen
 * (SVG origin is top-left).
 *
 * @param points   Output of `toSparkPoints`.
 * @param width    SVG viewport width in px.
 * @param height   SVG viewport height in px.
 * @param padding  Padding applied to all four edges so points don't clip.
 * @returns        Array of `{ x, y }` pixel coordinates.
 */
export const toPixelPoints = (
  points: readonly SparkPoint[],
  width: number,
  height: number,
  padding = 4,
): Array<{ x: number; y: number }> => {
  if (points.length === 0) return [];
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const step = points.length > 1 ? innerW / (points.length - 1) : 0;

  return points.map((pt, i) => ({
    x: padding + i * step,
    // Flip: y=1 → top of chart (high), y=0 → bottom.
    y: padding + innerH * (1 - pt.y),
  }));
};

/**
 * Render pixel coordinates as an SVG `points` attribute string.
 * e.g.  "4,36 54,20 104,8"
 */
export const toPolylinePoints = (pixels: ReadonlyArray<{ x: number; y: number }>): string =>
  pixels.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
