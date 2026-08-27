import { describe, expect, it } from 'vitest';
import {
  AddHoursDailySchema,
  AddHoursTotalSchema,
  CsvImportRowSchema,
  EditTotalSchema,
} from '@/types/schemas/time';

// Valid v4 UUIDs — Zod v4 .uuid() rejects the all-1s placeholder.
const companyId = '11111111-1111-4111-8111-111111111111';
const workerId = '22222222-2222-4222-8222-222222222222';

const total = (hours: number) =>
  AddHoursTotalSchema.safeParse({
    companyId,
    workerId,
    sourceName: 'Ana Cruz',
    periodStart: '2026-07-01',
    hours,
  });

const daily = (days: Array<{ date: string; hours: number }>) =>
  AddHoursDailySchema.safeParse({ companyId, workerId, sourceName: 'Ana Cruz', days });

describe('manual-hours sanity bounds (RP-40)', () => {
  it('accepts a normal semi-monthly total', () => {
    expect(total(88).success).toBe(true);
  });

  it('rejects the 800-for-80 typo that would otherwise pay 10×', () => {
    expect(total(800).success).toBe(false);
  });

  it('rejects a non-finite total', () => {
    expect(total(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(total(Number.NaN).success).toBe(false);
  });

  it('accepts a plausible day and rejects more hours than a day has', () => {
    expect(daily([{ date: '2026-07-01', hours: 8 }]).success).toBe(true);
    expect(daily([{ date: '2026-07-01', hours: 25 }]).success).toBe(false);
  });

  it('rejects daily dates that straddle a pay-period boundary', () => {
    expect(
      daily([
        { date: '2026-07-15', hours: 8 },
        { date: '2026-07-16', hours: 8 },
      ]).success,
    ).toBe(false);
  });

  it('accepts several days inside one period', () => {
    expect(
      daily([
        { date: '2026-07-16', hours: 8 },
        { date: '2026-07-31', hours: 8 },
      ]).success,
    ).toBe(true);
  });

  it('caps an edit-total the same way (0 stays legal — it clears a contractor)', () => {
    const base = {
      companyId,
      sourceName: 'Ana Cruz',
      ids: [workerId],
      periodStart: '2026-07-01',
      periodEnd: '2026-07-15',
    };
    expect(EditTotalSchema.safeParse({ ...base, hours: 0 }).success).toBe(true);
    expect(EditTotalSchema.safeParse({ ...base, hours: 800 }).success).toBe(false);
  });

  it('caps a CSV row at 24h of tracked seconds', () => {
    const base = { sourceName: 'Ana Cruz', workerId, workDate: '2026-07-01', activityPct: null };
    expect(CsvImportRowSchema.safeParse({ ...base, trackedSeconds: 86_400 }).success).toBe(true);
    expect(CsvImportRowSchema.safeParse({ ...base, trackedSeconds: 86_401 }).success).toBe(false);
  });
});
