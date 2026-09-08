/**
 * Contract-change wizard, slice 2 (docs/CONTRACT-CHANGE-WIZARD-PLAN.md decision 4):
 * the Increase step's arithmetic and the history line written from it.
 */

import { describe, expect, it } from 'vitest';
import { applyIncrease, describeIncrease } from '@/lib/contracts/increase';

describe('applyIncrease', () => {
  it('percent rounds to the nearest peso, either direction', () => {
    expect(applyIncrease('percent', 5, 8000)).toBe(8400);
    expect(applyIncrease('percent', 3.3, 8000)).toBe(8264);
    expect(applyIncrease('percent', -10, 8000)).toBe(7200);
  });

  it('flat adds pesos and exact is the figure itself, both to the centavo', () => {
    expect(applyIncrease('flat', 500.25, 8000)).toBe(8500.25);
    expect(applyIncrease('flat', -500, 8000)).toBe(7500);
    expect(applyIncrease('exact', 9000.019, 8000)).toBe(9000.02);
  });

  it('needs a base for a relative change, and a number', () => {
    expect(applyIncrease('percent', 5, null)).toBeNull();
    expect(applyIncrease('flat', 500, null)).toBeNull();
    expect(applyIncrease('exact', 9000, null)).toBe(9000);
    expect(applyIncrease('percent', Number.NaN, 8000)).toBeNull();
  });
});

describe('describeIncrease', () => {
  it('reads "+5% · 8,000 → 8,400"', () => {
    expect(
      describeIncrease({ method: 'percent', value: 5, from: 8000, to: 8400, base: 'record' }),
    ).toBe('+5% · 8,000 → 8,400');
    expect(
      describeIncrease({ method: 'flat', value: -500, from: 8000, to: 7500, base: 'record' }),
    ).toBe('−500 · 8,000 → 7,500');
    expect(
      describeIncrease({ method: 'exact', value: 9000, from: 8000, to: 9000, base: 'live' }),
    ).toBe('8,000 → 9,000');
  });

  it('is silent when the rate did not move or there was nothing to move from', () => {
    expect(
      describeIncrease({ method: 'exact', value: 8000, from: 8000, to: 8000, base: 'record' }),
    ).toBeNull();
    expect(
      describeIncrease({ method: 'exact', value: 8000, from: null, to: 8000, base: 'record' }),
    ).toBeNull();
  });
});
