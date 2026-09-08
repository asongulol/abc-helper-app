/**
 * PTO accrual (docs/CONTRACT-CHANGE-WIZARD-PLAN.md decision 7): 12 × tracked ÷
 * 2,080 capped at the contract's days, used = PTO ÷ 8 h, carry-over with a
 * 30-day ceiling.
 */

import { describe, expect, it } from 'vitest';
import { ptoAccrual } from '@/lib/pay/pto';

const h = (hours: number) => hours * 3600;

describe('ptoAccrual', () => {
  it('a full-time year earns 12 days; a day used is 8 h', () => {
    const [y] = ptoAccrual([{ year: 2025, trackedSeconds: h(2080), ptoSeconds: h(16) }], 12);
    expect(y).toEqual({
      year: 2025,
      trackedHours: 2080,
      accruedDays: 12,
      usedDays: 2,
      carriedInDays: 0,
      balanceDays: 10,
    });
  });

  it('part-timers reach less; overtime is capped at the contract days', () => {
    const [half, over] = ptoAccrual(
      [
        { year: 2024, trackedSeconds: h(1040), ptoSeconds: 0 },
        { year: 2025, trackedSeconds: h(3000), ptoSeconds: 0 },
      ],
      10,
    );
    expect(half?.accruedDays).toBe(6);
    expect(over?.accruedDays).toBe(10);
  });

  it('carries the balance over, oldest year first, up to the 30-day ceiling', () => {
    const rows = ptoAccrual(
      [
        { year: 2026, trackedSeconds: h(2080), ptoSeconds: h(80) },
        { year: 2024, trackedSeconds: h(2080), ptoSeconds: 0 },
        { year: 2025, trackedSeconds: h(2080), ptoSeconds: 0 },
        { year: 2023, trackedSeconds: h(2080), ptoSeconds: 0 },
      ],
      12,
    );
    expect(rows.map((r) => [r.year, r.carriedInDays, r.balanceDays])).toEqual([
      [2023, 0, 12],
      [2024, 12, 24],
      [2025, 24, 30], // 36 earned, ceiling 30
      [2026, 30, 30], // 30 + 12 − 10 = 32 → ceiling again
    ]);
  });

  it('can go negative when more is used than earned — a fact for the admin, not a block', () => {
    const [y] = ptoAccrual([{ year: 2025, trackedSeconds: h(520), ptoSeconds: h(40) }], 12);
    expect(y).toMatchObject({ accruedDays: 3, usedDays: 5, balanceDays: -2 });
  });
});
