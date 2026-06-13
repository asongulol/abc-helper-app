import { defaultHolidays, holidaysInRange } from '@/lib/pay/holidays';
import { describe, expect, it } from 'vitest';

const datesByName = (year: number): Record<string, string> =>
  Object.fromEntries(defaultHolidays(year).map((h) => [h.name, h.date]));

describe('defaultHolidays — the offices’ observed list (legacy ~5820)', () => {
  it('computes the 2026 calendar correctly', () => {
    const h = datesByName(2026);
    expect(h["New Year's Day"]).toBe('2026-01-01');
    expect(h['Martin Luther King Jr. Day']).toBe('2026-01-19'); // 3rd Mon Jan
    expect(h['Good Friday']).toBe('2026-04-03'); // Easter 2026-04-05 − 2
    expect(h['Memorial Day']).toBe('2026-05-25'); // last Mon May
    expect(h['Independence Day']).toBe('2026-07-04');
    expect(h['Labor Day']).toBe('2026-09-07'); // 1st Mon Sep
    expect(h["Indigenous Peoples' Day"]).toBe('2026-10-12'); // 2nd Mon Oct
    expect(h['Thanksgiving Day']).toBe('2026-11-26'); // 4th Thu Nov
    expect(h['Day after Thanksgiving']).toBe('2026-11-27');
    expect(h['Christmas Day']).toBe('2026-12-25');
  });

  it('computes Easter-dependent dates across years', () => {
    expect(datesByName(2025)['Good Friday']).toBe('2025-04-18'); // Easter 2025-04-20
    expect(datesByName(2024)['Good Friday']).toBe('2024-03-29'); // Easter 2024-03-31
  });
});

describe('holidaysInRange', () => {
  it('filters to the window and weekdays only', () => {
    const list = defaultHolidays(2026);
    // Jul 4 2026 is a Saturday — excluded when weekdayOnly.
    expect(holidaysInRange(list, '2026-07-01', '2026-07-15', true)).toHaveLength(0);
    expect(holidaysInRange(list, '2026-07-01', '2026-07-15', false)).toHaveLength(1);
    // Christmas 2026 is a Friday — included.
    expect(holidaysInRange(list, '2026-12-16', '2026-12-31', true).map((h) => h.name)).toEqual([
      'Christmas Day',
    ]);
  });
});
