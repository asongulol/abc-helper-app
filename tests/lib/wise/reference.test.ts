import { describe, expect, it } from 'vitest';
import { referenceDates, referenceMatchesPeriod } from '@/lib/wise/reference';

/** 2026-07-01→15, deadline 2026-07-31. Paid by the batch sent 2026-07-28. */
const july = { periodStart: '2026-07-01', periodEnd: '2026-07-15', payDate: '2026-07-31' };

describe('referenceDates', () => {
  it('reads both shapes the owner actually writes', () => {
    expect(referenceDates('Payroll 2026-07-15')).toEqual([Date.UTC(2026, 6, 15)]);
    expect(referenceDates('20240712')).toEqual([Date.UTC(2024, 6, 12)]);
    expect(referenceDates('20231215 and 13th Pt 2')).toEqual([Date.UTC(2023, 11, 15)]);
  });

  it('ignores a bare year — "Health Allowance 2024" is a benefit, not a period', () => {
    expect(referenceDates('Health Allowance 2024')).toEqual([]);
    expect(referenceDates('Payroll')).toEqual([]);
    expect(referenceDates('')).toEqual([]);
    expect(referenceDates(null)).toEqual([]);
    expect(referenceDates('ATTURFT111FU1119')).toEqual([]);
  });
});

describe('referenceMatchesPeriod', () => {
  it('confirms a reference naming this period (by its end date)', () => {
    // Sent 2026-07-28, two weeks after the period closed — the reference is what
    // says which period it pays.
    expect(referenceMatchesPeriod('Payroll 2026-07-15', july)).toBe(true);
  });

  it('confirms a send-date reference inside the period span', () => {
    // "20240712" — the 2024-06-16→30 batch, referenced by the day it went out.
    expect(
      referenceMatchesPeriod('20240712', {
        periodStart: '2024-06-16',
        periodEnd: '2024-06-30',
        payDate: '2024-07-15',
      }),
    ).toBe(true);
  });

  it('rejects a reference naming a DIFFERENT period — the duplicate guard', () => {
    // The 2026-07-28 shape: a transfer sitting in the next period's window whose
    // reference says it paid the last one. Auto-linking it marks a period paid
    // that nobody paid.
    expect(
      referenceMatchesPeriod('Payroll 2026-07-15', {
        periodStart: '2026-07-16',
        periodEnd: '2026-07-31',
        payDate: '2026-08-15',
      }),
    ).toBe(false);
    expect(referenceMatchesPeriod('Payroll 2026-05-15', july)).toBe(false);
  });

  it('has NO opinion when there is no date to read', () => {
    // Most transfers land here — this can only ever be one input among several.
    expect(referenceMatchesPeriod('Payroll', july)).toBeNull();
    expect(referenceMatchesPeriod(null, july)).toBeNull();
    expect(referenceMatchesPeriod('Health Allowance 2024', july)).toBeNull();
  });

  it('has no opinion when the period has no dates to compare against', () => {
    expect(referenceMatchesPeriod('Payroll 2026-07-15', {})).toBeNull();
  });
});
