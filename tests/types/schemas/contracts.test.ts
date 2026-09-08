/**
 * Contract-change wizard, slice 1 (docs/CONTRACT-CHANGE-WIZARD-PLAN.md decision 2):
 * every version carries a reason, and "Other" has to say what it is.
 */

import { describe, expect, it } from 'vitest';
import { DraftContractVersionSchema } from '@/types/schemas/contracts';

const base = {
  workerId: '11111111-1111-4111-8111-111111111111',
  companyId: '22222222-2222-4222-8222-222222222222',
  ratePhp: 8000,
  startDate: '2026-01-05',
  effectiveFrom: '2026-09-16',
};

describe('DraftContractVersionSchema — change reason', () => {
  it('requires a reason', () => {
    const r = DraftContractVersionSchema.safeParse(base);
    expect(r.success).toBe(false);
  });

  it('accepts a reason with no note', () => {
    const r = DraftContractVersionSchema.safeParse({ ...base, changeReason: 'annual_review' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.changeNote).toBeNull();
  });

  it('needs a note when the reason is Other', () => {
    expect(DraftContractVersionSchema.safeParse({ ...base, changeReason: 'other' }).success).toBe(
      false,
    );
    expect(
      DraftContractVersionSchema.safeParse({ ...base, changeReason: 'other', changeNote: '  ' })
        .success,
    ).toBe(false);
    expect(
      DraftContractVersionSchema.safeParse({
        ...base,
        changeReason: 'other',
        changeNote: 'Moved to a 4-day week',
      }).success,
    ).toBe(true);
  });
});

describe('DraftContractVersionSchema — increase detail (slice 2, decision 4)', () => {
  const increase = { method: 'percent', value: 5, from: 8000, to: 8400, base: 'record' };
  const draft = (over: Record<string, unknown>) =>
    DraftContractVersionSchema.safeParse({ ...base, changeReason: 'annual_review', ...over });

  it('is optional — a rate typed straight in has no detail', () => {
    const r = draft({ ratePhp: 8400 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.changeDetail).toBeNull();
  });

  it('must add up to the rate stored, by its own method', () => {
    expect(draft({ ratePhp: 8400, changeDetail: { increase } }).success).toBe(true);
    // Rate disagrees with the detail.
    expect(draft({ ratePhp: 8500, changeDetail: { increase } }).success).toBe(false);
    // Detail agrees with itself but 5% of 8,000 is not 8,500.
    expect(
      draft({ ratePhp: 8500, changeDetail: { increase: { ...increase, to: 8500 } } }).success,
    ).toBe(false);
  });
});
