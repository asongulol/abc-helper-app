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
