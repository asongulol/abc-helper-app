import { describe, expect, it } from 'vitest';
import { CalculateDraftSchema } from '@/types/schemas/payroll';

const base = {
  // Valid v4 UUID (version nibble 4, variant nibble 8) — Zod v4 .uuid() rejects
  // the all-1s placeholder.
  companyId: '11111111-1111-4111-8111-111111111111',
  payDate: '2026-06-30',
};

describe('CalculateDraftSchema', () => {
  it('F11: includeThirteenth defaults false; includeHealthAllowance defaults true', () => {
    const parsed = CalculateDraftSchema.parse({
      ...base,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
    });
    expect(parsed.includeThirteenth).toBe(false);
    expect(parsed.includeHealthAllowance).toBe(true);
  });

  it('New-3: accepts a canonical 1–15 semi-monthly period', () => {
    expect(
      CalculateDraftSchema.safeParse({
        ...base,
        periodStart: '2026-06-01',
        periodEnd: '2026-06-15',
      }).success,
    ).toBe(true);
  });

  it('New-3: accepts a canonical 16–EOM period (incl. 30-day month)', () => {
    expect(
      CalculateDraftSchema.safeParse({
        ...base,
        periodStart: '2026-06-16',
        periodEnd: '2026-06-30',
      }).success,
    ).toBe(true);
  });

  it('New-3: rejects a misaligned / overlapping range', () => {
    const res = CalculateDraftSchema.safeParse({
      ...base,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-20', // not a semi-monthly boundary
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toMatch(/semi-monthly/);
    }
  });

  it('New-3: rejects a wrong end for a valid start (e.g. June ends on the 30th, not 31st)', () => {
    expect(
      CalculateDraftSchema.safeParse({
        ...base,
        periodStart: '2026-06-16',
        periodEnd: '2026-06-31',
      }).success,
    ).toBe(false);
  });
});
