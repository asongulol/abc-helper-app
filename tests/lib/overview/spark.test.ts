import { describe, expect, it } from 'vitest';
import { toPixelPoints, toPolylinePoints, toSparkPoints } from '../../../src/lib/overview/spark';

describe('toSparkPoints', () => {
  it('returns empty array for empty input', () => {
    expect(toSparkPoints([])).toEqual([]);
  });

  it('single period → y = 0.5 (flat line)', () => {
    const pts = toSparkPoints([{ label: 'Jun 1–15', totalNetPhp: 10000 }]);
    expect(pts).toHaveLength(1);
    expect(pts[0]?.y).toBe(0.5);
    expect(pts[0]?.totalNetPhp).toBe(10000);
  });

  it('all equal values → y = 0.5 for all (flat line)', () => {
    const input = [
      { label: 'A', totalNetPhp: 5000 },
      { label: 'B', totalNetPhp: 5000 },
      { label: 'C', totalNetPhp: 5000 },
    ];
    const pts = toSparkPoints(input);
    expect(pts).toHaveLength(3);
    for (const pt of pts) {
      expect(pt.y).toBe(0.5);
    }
  });

  it('min period → y = 0, max period → y = 1', () => {
    const input = [
      { label: 'Low', totalNetPhp: 1000 },
      { label: 'Mid', totalNetPhp: 5500 },
      { label: 'High', totalNetPhp: 10000 },
    ];
    const pts = toSparkPoints(input);
    expect(pts[0]?.y).toBe(0);
    expect(pts[2]?.y).toBe(1);
    // Mid: (5500-1000)/(10000-1000) = 4500/9000 = 0.5
    expect(pts[1]?.y).toBeCloseTo(0.5);
  });

  it('uses integer centavos arithmetic (no float accumulation)', () => {
    // totalNetPhp that could cause float trouble if summed naively
    const input = [
      { label: 'A', totalNetPhp: 0.1 },
      { label: 'B', totalNetPhp: 0.2 },
    ];
    const pts = toSparkPoints(input);
    // 0.1+0.2 = 0.30000000000000004 in floats, but centavos are 10 and 20
    expect(pts[0]?.y).toBe(0);
    expect(pts[1]?.y).toBe(1);
  });

  it('preserves original labels and totalNetPhp', () => {
    const input = [
      { label: 'May 16–31', totalNetPhp: 80000 },
      { label: 'Jun 1–15', totalNetPhp: 95000 },
    ];
    const pts = toSparkPoints(input);
    expect(pts[0]?.label).toBe('May 16–31');
    expect(pts[1]?.label).toBe('Jun 1–15');
    expect(pts[0]?.totalNetPhp).toBe(80000);
    expect(pts[1]?.totalNetPhp).toBe(95000);
  });
});

describe('toPixelPoints', () => {
  it('maps y=0 (min) to bottom, y=1 (max) to top', () => {
    const input = [
      { label: 'Low', totalNetPhp: 0, y: 0 },
      { label: 'High', totalNetPhp: 1000, y: 1 },
    ];
    const px = toPixelPoints(input, 100, 40, 4);
    // y=0 → bottom = 4 + 32 * (1-0) = 36
    expect(px[0]?.y).toBeCloseTo(36);
    // y=1 → top = 4 + 32 * (1-1) = 4
    expect(px[1]?.y).toBeCloseTo(4);
  });

  it('single point is placed at x = padding', () => {
    const px = toPixelPoints([{ label: 'X', totalNetPhp: 100, y: 0.5 }], 100, 40, 4);
    expect(px[0]?.x).toBe(4);
  });

  it('returns empty for empty input', () => {
    expect(toPixelPoints([], 100, 40)).toEqual([]);
  });
});

describe('toPolylinePoints', () => {
  it('formats coordinates as SVG points string', () => {
    const result = toPolylinePoints([
      { x: 4, y: 36 },
      { x: 50, y: 20 },
      { x: 96, y: 4 },
    ]);
    expect(result).toBe('4.0,36.0 50.0,20.0 96.0,4.0');
  });

  it('returns empty string for empty input', () => {
    expect(toPolylinePoints([])).toBe('');
  });
});
