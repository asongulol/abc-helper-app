import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/env', () => ({ env: { WISE_API_TOKEN: 'test-token' } }));

import { type AttributableRow, planAttribution, planUndo } from '@/server/wise/attribution';

/** ₱31,290 gross, nothing else — net ₱31,290. The 2026-05 Dunan shape. */
const row = (over: Partial<AttributableRow> = {}): AttributableRow => ({
  gross_php: 31290,
  health_allowance_php: 0,
  thirteenth_month_php: 0,
  pdd_lunch_php: 0,
  bonus_php: 0,
  misc_items: [],
  off_cycle_php: 0,
  ...over,
});

describe('planAttribution — where a reconcile variance lands', () => {
  it('misc: appends a labelled line and closes the gap exactly', () => {
    // Wise sent ₱36,290 against a ₱31,290 row — the real "123 BT Bookkeeping" case.
    const plan = planAttribution(row(), {
      delta: 5000,
      target: 'misc',
      label: '123 BT Bookkeeping',
      companyId: 'co-123',
    });
    expect(plan.netPhp).toBe(36290);
    expect(plan.miscItems).toEqual([
      {
        kind: 'other_earns',
        label: '123 BT Bookkeeping',
        amount: 5000,
        companyId: 'co-123',
        source: 'reconcile',
      },
    ]);
  });

  it('misc: a negative delta becomes a deduction, not a negative earning', () => {
    const plan = planAttribution(row(), { delta: -1500, target: 'misc', label: 'Undertime' });
    expect(plan.miscItems?.[0]?.kind).toBe('deduction');
    expect(plan.miscItems?.[0]?.amount).toBe(1500);
    expect(plan.netPhp).toBe(29790);
  });

  it('keeps misc lines the row already had', () => {
    const existing = { kind: 'other_earns', label: 'Lunch', amount: 500 };
    const plan = planAttribution(row({ misc_items: [existing] }), { delta: 5000, target: 'misc' });
    expect(plan.miscItems).toHaveLength(2);
    expect(plan.miscItems?.[0]).toEqual(existing);
    expect(plan.netPhp).toBe(36790);
  });

  it('health allowance / 13th month add to the column and recompute net', () => {
    const ha = planAttribution(row({ health_allowance_php: 20000 }), {
      delta: 5000,
      target: 'health_allowance',
    });
    expect(ha.haPhp).toBe(25000);
    expect(ha.prevValue).toBe(20000);
    expect(ha.netPhp).toBe(56290);

    const t13 = planAttribution(row({ thirteenth_month_php: 1000 }), {
      delta: -400,
      target: 'thirteenth_month',
    });
    expect(t13.t13Php).toBe(600);
    expect(t13.netPhp).toBe(31890);
  });

  it('REFUSES to push health allowance below zero — never clamps it', () => {
    // HA pays in one anniversary period a year with no carry-forward (#84);
    // clamping to 0 here destroys a year of it to make one row balance.
    expect(() =>
      planAttribution(row({ health_allowance_php: 1000 }), {
        delta: -5000,
        target: 'health_allowance',
      }),
    ).toThrow(/negative/i);
    expect(() =>
      planAttribution(row({ thirteenth_month_php: 0 }), { delta: -1, target: 'thirteenth_month' }),
    ).toThrow(/negative/i);
  });

  it('refuses a delta under a centavo — that is not a variance', () => {
    expect(() => planAttribution(row(), { delta: 0.004, target: 'misc' })).toThrow(/Nothing/);
    expect(() => planAttribution(row(), { delta: 0, target: 'health_allowance' })).toThrow(
      /Nothing/,
    );
  });
});

describe('planUndo — a mis-picked target is not permanent', () => {
  it("drops the reconcile line it added, keeping the operator's own lines", () => {
    const mine = { kind: 'other_earns', label: 'Lunch', amount: 500 };
    const applied = planAttribution(row({ misc_items: [mine] }), {
      delta: 5000,
      target: 'misc',
      label: 'Bookkeeping',
    });
    const undone = planUndo(row({ misc_items: applied.miscItems ?? [] }), {
      target: 'misc',
      delta: 5000,
      prevValue: null,
      label: 'Bookkeeping',
    });
    expect(undone.miscItems).toEqual([mine]);
    expect(undone.netPhp).toBe(31790);
  });

  it('restores the exact previous allowance figure', () => {
    const applied = planAttribution(row({ health_allowance_php: 20000 }), {
      delta: 5000,
      target: 'health_allowance',
    });
    const undone = planUndo(row({ health_allowance_php: applied.haPhp ?? 0 }), {
      target: 'health_allowance',
      delta: 5000,
      prevValue: applied.prevValue,
    });
    expect(undone.haPhp).toBe(20000);
    expect(undone.netPhp).toBe(51290);
  });

  it('says so when the line is already gone instead of dropping the wrong one', () => {
    expect(() =>
      planUndo(row({ misc_items: [{ kind: 'other_earns', label: 'Lunch', amount: 500 }] }), {
        target: 'misc',
        delta: 5000,
        prevValue: null,
        label: 'Bookkeeping',
      }),
    ).toThrow(/no longer/);
  });
});
