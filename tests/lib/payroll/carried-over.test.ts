import { describe, expect, it } from 'vitest';
import { isCarriedOverClone } from '@/lib/payroll/carried-over';

const row = (workerId: string, gross: number, net: number, wh: number, misc: unknown = []) => ({
  workerId,
  grossPhp: gross,
  netPhp: net,
  workedHours: wh,
  miscItems: misc,
});

describe('isCarriedOverClone', () => {
  it('flags a draft that mirrors the previous period (one worker seeded differently)', () => {
    // The real-world case: 2 of 3 rows byte-identical to last period, 1 differs.
    const prev = [row('a', 100, 100, 10), row('b', 200, 200, 20), row('c', 0, 70, 0)];
    const current = [row('a', 100, 100, 10), row('b', 200, 200, 20), row('c', 60, 60, 0)];
    expect(isCarriedOverClone(current, prev)).toBe(true);
  });

  it('does NOT flag once recomputed from this period’s hours', () => {
    const prev = [row('a', 100, 100, 10), row('b', 200, 200, 20)];
    const current = [row('a', 150, 150, 15), row('b', 240, 240, 24)];
    expect(isCarriedOverClone(current, prev)).toBe(false);
  });

  it('does NOT flag a deduction carried into misc — the misc JSON breaks the match', () => {
    const prev = [row('a', 100, 100, 10)];
    const current = [row('a', 100, 100, 10, [{ kind: 'deduction', label: 'x', amount: 50 }])];
    expect(isCarriedOverClone(current, prev)).toBe(false);
  });

  it('no previous period → not carried over', () => {
    expect(isCarriedOverClone([row('a', 1, 1, 1)], [])).toBe(false);
  });
});
