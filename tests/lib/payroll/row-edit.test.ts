import { describe, expect, it } from 'vitest';
import { hasManualAdjustments, miscPatch } from '@/lib/payroll/row-edit';

const base = {
  overridden: false,
  haPhp: 0,
  pddPhp: 0,
  bonusPhp: 0,
  t13Php: 0,
  computedT13Php: 0,
  miscItems: [],
};

describe('hasManualAdjustments — the typed-RECALCULATE gate (RP-24)', () => {
  it('is false for a pristine engine-built row', () => {
    expect(hasManualAdjustments(base)).toBe(false);
  });

  it('is TRUE when only the 13th month was set by hand — the missed case', () => {
    // Batch calculated with 13th unchecked (computed 0); admin typed 9583 in Misc.
    expect(hasManualAdjustments({ ...base, t13Php: 9583, computedT13Php: 0 })).toBe(true);
  });

  it('is true when a computed 13th was overridden to a different amount', () => {
    expect(hasManualAdjustments({ ...base, t13Php: 5000, computedT13Php: 9583 })).toBe(true);
  });

  it('stays false when the 13th still equals the computed value', () => {
    expect(hasManualAdjustments({ ...base, t13Php: 9583, computedT13Php: 9583 })).toBe(false);
  });

  it('still catches the adjustments it already caught', () => {
    expect(hasManualAdjustments({ ...base, overridden: true })).toBe(true);
    expect(hasManualAdjustments({ ...base, haPhp: 1666.67 })).toBe(true);
    expect(hasManualAdjustments({ ...base, pddPhp: 200 })).toBe(true);
    expect(hasManualAdjustments({ ...base, bonusPhp: 500 })).toBe(true);
    expect(
      hasManualAdjustments({
        ...base,
        miscItems: [{ kind: 'deduction', label: 'SSS', amount: 500 }],
      }),
    ).toBe(true);
  });
});

describe('miscPatch — cleared 13th reverts to computed, not ₱0 (RP-21)', () => {
  const payload = {
    haPhp: 0,
    t13Php: null,
    pddPhp: 0,
    bonusPhp: 0,
    miscItems: [],
  };

  it('restores the computed 13th month when the field was cleared', () => {
    // The modal's own label previews "computed: ₱9,583.00" for this case.
    expect(miscPatch({ computedT13Php: 9583 }, payload).t13Php).toBe(9583);
  });

  it('keeps a typed 13th month verbatim', () => {
    expect(miscPatch({ computedT13Php: 9583 }, { ...payload, t13Php: 5000 }).t13Php).toBe(5000);
  });

  it('keeps a deliberate zero typed into the field', () => {
    // 0 is a value, not "cleared" — the modal only sends null for an empty field.
    expect(miscPatch({ computedT13Php: 9583 }, { ...payload, t13Php: 0 }).t13Php).toBe(0);
  });

  it('passes the other components through untouched', () => {
    const items = [{ kind: 'other_earns' as const, label: 'Referral', amount: 250 }];
    expect(
      miscPatch(
        { computedT13Php: 0 },
        { haPhp: 1666.67, t13Php: null, pddPhp: 200, bonusPhp: 500, miscItems: items },
      ),
    ).toEqual({
      haPhp: 1666.67,
      t13Php: 0,
      pddPhp: 200,
      bonusPhp: 500,
      miscItems: items,
    });
  });
});
