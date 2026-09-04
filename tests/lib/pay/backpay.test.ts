/**
 * Contract backpay pricing (docs/CONTRACT-VERSIONS-PLAN.md slice 4b): a paid
 * period is owed paid × (new − old) / old, prorated by working days on/after
 * the effective date; never negative.
 */

import { describe, expect, it } from 'vitest';
import { centavos } from '@/lib/money';
import { backpayForPaid, prorationFor } from '@/lib/pay/backpay';

const c = (n: number) => centavos(n);

describe('prorationFor', () => {
  // 2026-07-01 is a Wednesday: 3 + 5 + 3 = 11 working days in 1–15.
  it('covers the whole period when the effective date is on or before its start', () => {
    expect(prorationFor('2026-07-01', '2026-07-15', '2026-06-20')).toEqual({
      coveredDays: 11,
      totalDays: 11,
      fraction: 1,
    });
  });
  it('counts working days from the effective date', () => {
    expect(prorationFor('2026-07-01', '2026-07-15', '2026-07-06')).toEqual({
      coveredDays: 8,
      totalDays: 11,
      fraction: 8 / 11,
    });
  });
  it('is zero after the period', () => {
    expect(prorationFor('2026-07-01', '2026-07-15', '2026-07-16').fraction).toBe(0);
  });
});

describe('backpayForPaid', () => {
  const full = prorationFor('2026-07-01', '2026-07-15', '2026-07-01');
  it('equals the engine difference (new − old) × min(ratio, 1) for a salaried row', () => {
    // paid ₱8,000 at ₱10,000 (ratio .8) → at ₱12,000 would be ₱9,600
    expect(
      backpayForPaid({
        paid: c(800000),
        oldRate: c(1000000),
        newRate: c(1200000),
        proration: full,
      }),
    ).toBe(160000);
  });
  it('prorates and rounds to the centavo', () => {
    const part = prorationFor('2026-07-01', '2026-07-15', '2026-07-06');
    // 1,600.00 × 8/11 = 1,163.636… → 1,163.64
    expect(
      backpayForPaid({
        paid: c(800000),
        oldRate: c(1000000),
        newRate: c(1200000),
        proration: part,
      }),
    ).toBe(116364);
  });
  it('never claws back a rate that went down', () => {
    expect(
      backpayForPaid({ paid: c(800000), oldRate: c(1000000), newRate: c(900000), proration: full }),
    ).toBe(0);
  });
  it('cannot price a row with no rate', () => {
    expect(
      backpayForPaid({ paid: c(800000), oldRate: c(0), newRate: c(1200000), proration: full }),
    ).toBe(0);
  });
});
