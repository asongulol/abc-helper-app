import { describe, expect, it } from 'vitest';
import {
  isDateInAnyPeriod,
  isWeekday,
  lastDayOfMonth,
  periodDates,
  periodFor,
  previousPeriod,
  weekdayCount,
} from '@/lib/dates/periods';

describe('periodFor — semi-monthly arrears periods (legacy ~5901)', () => {
  it('first half: 1–15 paid end of SAME month', () => {
    expect(periodFor('2026-06-12')).toEqual({
      start: '2026-06-01',
      end: '2026-06-15',
      payDate: '2026-06-30',
    });
    expect(periodFor('2026-06-01')).toEqual({
      start: '2026-06-01',
      end: '2026-06-15',
      payDate: '2026-06-30',
    });
    expect(periodFor('2026-06-15').payDate).toBe('2026-06-30');
  });

  it('second half: 16–EOM paid 15th of NEXT month', () => {
    expect(periodFor('2026-06-16')).toEqual({
      start: '2026-06-16',
      end: '2026-06-30',
      payDate: '2026-07-15',
    });
  });

  it('December second half rolls the pay date into January', () => {
    expect(periodFor('2026-12-20')).toEqual({
      start: '2026-12-16',
      end: '2026-12-31',
      payDate: '2027-01-15',
    });
  });

  it('handles leap February', () => {
    expect(periodFor('2024-02-20')).toEqual({
      start: '2024-02-16',
      end: '2024-02-29',
      payDate: '2024-03-15',
    });
    expect(periodFor('2025-02-20').end).toBe('2025-02-28');
  });
});

describe('periodDates', () => {
  it('lists every date inclusive', () => {
    const dates = periodDates('2026-06-01', '2026-06-15');
    expect(dates).toHaveLength(15);
    expect(dates[0]).toBe('2026-06-01');
    expect(dates[14]).toBe('2026-06-15');
  });

  it('crosses month boundaries', () => {
    expect(periodDates('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ]);
  });
});

describe('previousPeriod — the arrears review default', () => {
  it('second-half today → the preceding first half of the same month', () => {
    // Today 07/13 (first half of July) → preceding period is 06/16–06/30.
    expect(previousPeriod('2026-07-13')).toEqual(periodFor('2026-06-16'));
  });

  it('first-half today → the preceding second half', () => {
    // 07/20 is in 07/16–07/31; the one before is 07/01–07/15.
    expect(previousPeriod('2026-07-20')).toEqual(periodFor('2026-07-01'));
  });

  it('rolls back across a year boundary', () => {
    // 01/05 → period 01/01–01/15; the one before is Dec 16–31 of the prior year.
    expect(previousPeriod('2026-01-05')).toEqual(periodFor('2025-12-31'));
  });
});

describe('isDateInAnyPeriod', () => {
  const ranges = [
    { periodStart: '2026-06-01', periodEnd: '2026-06-15' },
    { periodStart: '2026-06-16', periodEnd: '2026-06-30' },
  ];
  it('true inside a range, inclusive of both bounds', () => {
    expect(isDateInAnyPeriod('2026-06-01', ranges)).toBe(true);
    expect(isDateInAnyPeriod('2026-06-30', ranges)).toBe(true);
    expect(isDateInAnyPeriod('2026-06-20', ranges)).toBe(true);
  });
  it('false outside every range and for an empty list', () => {
    expect(isDateInAnyPeriod('2026-07-01', ranges)).toBe(false);
    expect(isDateInAnyPeriod('2026-05-31', ranges)).toBe(false);
    expect(isDateInAnyPeriod('2026-06-20', [])).toBe(false);
  });
});

describe('date helpers', () => {
  it('weekdayCount counts Mon–Fri', () => {
    // June 1 2026 is a Monday; 1–15 has 11 weekdays.
    expect(weekdayCount('2026-06-01', '2026-06-15')).toBe(11);
  });
  it('isWeekday', () => {
    expect(isWeekday('2026-06-13')).toBe(false); // Saturday
    expect(isWeekday('2026-06-12')).toBe(true); // Friday
  });
  it('lastDayOfMonth', () => {
    expect(lastDayOfMonth(2024, 2)).toBe(29);
    expect(lastDayOfMonth(2025, 2)).toBe(28);
    expect(lastDayOfMonth(2026, 12)).toBe(31);
  });
});
