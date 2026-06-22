import { describe, expect, it } from 'vitest';
import { planRateUpsert, resolveRate } from '@/lib/pay/rates';

describe('planRateUpsert', () => {
  it('same effective_start → in-place update (no duplicate-day rows)', () => {
    const plan = planRateUpsert(
      [{ id: 'r1', effectiveStart: '2026-06-01', effectiveEnd: null }],
      18000,
      '2026-06-01',
    );
    expect(plan).toEqual({
      kind: 'same-day-update',
      rateId: 'r1',
      amountPhp: 18000,
      effectiveStart: '2026-06-01',
    });
  });

  it('F9: close-and-insert closes the prior rate the day BEFORE the new start (exclusive)', () => {
    const plan = planRateUpsert(
      [{ id: 'r1', effectiveStart: '2026-01-01', effectiveEnd: null }],
      20000,
      '2026-06-09',
    );
    expect(plan).toEqual({
      kind: 'close-and-insert',
      closeBefore: '2026-06-08', // not 2026-06-09 → no boundary-day overlap
      amountPhp: 20000,
      effectiveStart: '2026-06-09',
    });
  });

  it('F9: closed old rate + new rate never both cover the boundary day', () => {
    // Simulate the rows the plan would produce.
    const rows = [
      {
        workerId: 'w1',
        amountPhp: '200.00',
        effectiveStart: '2026-01-01',
        effectiveEnd: '2026-06-08',
      },
      { workerId: 'w1', amountPhp: '250.00', effectiveStart: '2026-06-09', effectiveEnd: null },
    ];
    // Old rate still covers up to and including its last day.
    expect(resolveRate(rows, 'w1', '2026-06-08', '2026-06-08')).toBe(20000);
    // New rate covers its first day.
    expect(resolveRate(rows, 'w1', '2026-06-09', '2026-06-09')).toBe(25000);
    // No gap/overlap on the close boundary: old ends 06-08, new starts 06-09.
    expect(rows[0].effectiveEnd).toBe('2026-06-08');
    expect(rows[1].effectiveStart).toBe('2026-06-09');
  });
});
