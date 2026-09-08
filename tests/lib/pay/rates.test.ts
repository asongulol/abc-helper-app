import { describe, expect, it } from 'vitest';
import { overlayPendingRates, planRateUpsert, resolveRate } from '@/lib/pay/rates';

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

describe('overlayPendingRates (early pricing, wizard decision 5)', () => {
  const live = {
    workerId: 'w1',
    amountPhp: 8000,
    effectiveStart: '2026-01-01',
    effectiveEnd: null,
  };
  const pending = { workerId: 'w1', amountPhp: 8400, effectiveStart: '2026-09-16' };

  it('prices from the effective date as countersign would: the open rate closes the day before', () => {
    const out = overlayPendingRates([live], [pending]);
    expect(resolveRate(out, 'w1', '2026-09-01', '2026-09-15')).toBe(800000);
    expect(resolveRate(out, 'w1', '2026-09-16', '2026-09-30')).toBe(840000);
    expect(out.find((r) => r.effectiveStart === '2026-01-01')?.effectiveEnd).toBe('2026-09-15');
  });

  it('goes either direction, and a same-day row is replaced rather than stacked', () => {
    const out = overlayPendingRates(
      [live],
      [{ workerId: 'w1', amountPhp: 7000, effectiveStart: '2026-01-01' }],
    );
    expect(out).toHaveLength(1);
    expect(resolveRate(out, 'w1', '2026-09-01', '2026-09-15')).toBe(700000);
  });

  it('leaves a future-dated rate and other workers alone, and never mutates the input', () => {
    const future = { ...live, amountPhp: 9000, effectiveStart: '2026-12-01' };
    const other = { ...live, workerId: 'w2', amountPhp: 5000 };
    const out = overlayPendingRates([live, future, other], [pending]);
    expect(out.find((r) => r.effectiveStart === '2026-12-01')?.effectiveEnd).toBeNull();
    expect(resolveRate(out, 'w2', '2026-09-16', '2026-09-30')).toBe(500000);
    expect(live.effectiveEnd).toBeNull();
  });
});
