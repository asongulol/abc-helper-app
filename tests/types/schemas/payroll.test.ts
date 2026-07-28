import { describe, expect, it } from 'vitest';
import {
  CalculateDraftSchema,
  RestoreSnapshotSchema,
  UpdatePaymentRowSchema,
} from '@/types/schemas/payroll';

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

describe('MiscItemSchema — amounts carry magnitude, `kind` carries the sign (RP-28)', () => {
  const item = (patch: Record<string, unknown>) =>
    UpdatePaymentRowSchema.safeParse({
      paymentId: base.companyId,
      companyId: base.companyId,
      miscItems: [{ kind: 'deduction', label: 'Cash advance', ...patch }],
    });

  it('accepts a normal positive deduction (what the editor emits)', () => {
    expect(item({ amount: 5000 }).success).toBe(true);
  });

  it('rejects a NEGATIVE deduction — miscTotal negates it, so it would ADD ₱5,000', () => {
    const res = item({ amount: -5000 });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0]?.message).toMatch(/positive number/i);
  });

  it('rejects a negative amount sent as a STRING (the column is jsonb, both occur)', () => {
    expect(item({ amount: '-5000' }).success).toBe(false);
  });

  it('rejects non-finite amounts', () => {
    expect(item({ amount: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(item({ amount: 'abc' }).success).toBe(false);
  });

  it('applies the same rule to hours', () => {
    expect(item({ kind: 'other_hours', hours: -8, amount: 100 }).success).toBe(false);
    expect(item({ kind: 'other_hours', hours: 8, amount: 100 }).success).toBe(true);
  });

  it('still allows an omitted / null amount (an hours-only or label-only line)', () => {
    expect(item({ amount: null }).success).toBe(true);
    expect(item({}).success).toBe(true);
  });
});

describe('RestoreSnapshotSchema — the undo no longer needs client rows (RP-23)', () => {
  it('parses with no `snapshot` at all: the server restores its own stored copy', () => {
    expect(
      RestoreSnapshotSchema.safeParse({ companyId: base.companyId, periodId: base.companyId })
        .success,
    ).toBe(true);
  });

  it('still parses the shell’s existing payload — the rows are accepted and ignored', () => {
    expect(
      RestoreSnapshotSchema.safeParse({
        companyId: base.companyId,
        periodId: base.companyId,
        snapshot: [{ id: 'x', net_php: 999999, status: 'sent', paid_at: '2020-01-01' }],
      }).success,
    ).toBe(true);
  });
});
