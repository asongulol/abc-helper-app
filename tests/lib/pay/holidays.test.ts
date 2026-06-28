import { describe, expect, it } from 'vitest';
import {
  defaultHolidays,
  holidaysInRange,
  observedDate,
  resolveHolidaysForRange,
} from '@/lib/pay/holidays';

const datesByName = (year: number): Record<string, string> =>
  Object.fromEntries(defaultHolidays(year).map((h) => [h.name, h.date]));

describe('defaultHolidays — the offices’ observed list (legacy ~5820)', () => {
  it('computes the 2026 calendar correctly', () => {
    const h = datesByName(2026);
    expect(h["New Year's Day"]).toBe('2026-01-01'); // Thursday — no shift
    expect(h['Martin Luther King Jr. Day']).toBe('2026-01-19'); // 3rd Mon Jan
    expect(h['Good Friday']).toBe('2026-04-03'); // Easter 2026-04-05 − 2
    expect(h['Memorial Day']).toBe('2026-05-25'); // last Mon May
    expect(h['Independence Day']).toBe('2026-07-03'); // Jul 4 is a Sat → observed Fri
    expect(h['Labor Day']).toBe('2026-09-07'); // 1st Mon Sep
    expect(h["Indigenous Peoples' Day"]).toBe('2026-10-12'); // 2nd Mon Oct
    expect(h['Thanksgiving Day']).toBe('2026-11-26'); // 4th Thu Nov
    expect(h['Day after Thanksgiving']).toBe('2026-11-27');
    expect(h['Christmas Day']).toBe('2026-12-25'); // Friday — no shift
  });

  it('computes Easter-dependent dates across years', () => {
    expect(datesByName(2025)['Good Friday']).toBe('2025-04-18'); // Easter 2025-04-20
    expect(datesByName(2024)['Good Friday']).toBe('2024-03-29'); // Easter 2024-03-31
  });

  it('shifts fixed-date holidays off weekends (US observance)', () => {
    // 2027: New Year's Day is a Friday (no shift), Independence Day (Jul 4) is a
    // Sunday → observed Monday Jul 5, Christmas (Dec 25) is a Saturday →
    // observed Friday Dec 24.
    const h = datesByName(2027);
    expect(h["New Year's Day"]).toBe('2027-01-01');
    expect(h['Independence Day']).toBe('2027-07-05');
    expect(h['Christmas Day']).toBe('2027-12-24');
  });
});

describe('observedDate', () => {
  it('Saturday → the Friday before', () => {
    expect(observedDate('2026-07-04')).toBe('2026-07-03'); // Sat → Fri
  });
  it('Sunday → the Monday after', () => {
    expect(observedDate('2027-07-04')).toBe('2027-07-05'); // Sun → Mon
  });
  it('weekdays pass through unchanged', () => {
    expect(observedDate('2026-12-25')).toBe('2026-12-25'); // Friday
    expect(observedDate('2026-06-03')).toBe('2026-06-03'); // Wednesday
  });
  it('a weekend holiday observes across the year boundary (New Year on a Sat)', () => {
    expect(observedDate('2028-01-01')).toBe('2027-12-31'); // Sat → Fri (prior year)
  });
});

describe('holidaysInRange', () => {
  it('counts the observed working day for a weekend holiday', () => {
    const list = defaultHolidays(2026);
    // Jul 4 2026 is a Saturday — observed on Fri Jul 3, which is in-window and counts.
    const observed = holidaysInRange(list, '2026-07-01', '2026-07-15', true);
    expect(observed.map((h) => [h.name, h.date])).toEqual([['Independence Day', '2026-07-03']]);
    // Christmas 2026 is a Friday — included as-is.
    expect(holidaysInRange(list, '2026-12-16', '2026-12-31', true).map((h) => h.name)).toEqual([
      'Christmas Day',
    ]);
  });

  it('without weekdayOnly, returns holidays by their literal date', () => {
    const list = defaultHolidays(2026);
    // The stored Independence Day is already the observed Fri Jul 3.
    expect(holidaysInRange(list, '2026-07-01', '2026-07-15', false).map((h) => h.date)).toEqual([
      '2026-07-03',
    ]);
  });

  it('shifts custom weekend holidays too, and dedupes a shared observed day', () => {
    const custom = [
      { name: 'Company Outing', date: '2026-07-04' }, // Sat → observed Fri Jul 3
      { name: 'Founders Day', date: '2026-07-03' }, // already Fri Jul 3 — same observed day
    ];
    // Both resolve to Jul 3; only one working day is lost.
    expect(holidaysInRange(custom, '2026-07-01', '2026-07-15', true)).toHaveLength(1);
  });
});

describe('resolveHolidaysForRange — per-year config override (companies.holidays_config)', () => {
  const has = (hs: { date: string }[], date: string) => hs.some((h) => h.date === date);

  it('falls back to defaults when config is null/empty', () => {
    const out = resolveHolidaysForRange(null, '2026-01-01', '2026-12-31');
    expect(has(out, '2026-12-25')).toBe(true); // Christmas default present
  });

  it('uses a configured year verbatim (authoritative — replaces defaults)', () => {
    const out = resolveHolidaysForRange(
      { '2026': [{ date: '2026-06-12', name: 'Company Outing' }] },
      '2026-06-01',
      '2026-06-30',
    );
    expect(has(out, '2026-06-12')).toBe(true);
    expect(has(out, '2026-12-25')).toBe(false); // defaults NOT mixed in for a configured year
  });

  it('an explicit empty year means no holidays (not defaults)', () => {
    const out = resolveHolidaysForRange({ '2026': [] }, '2026-12-01', '2026-12-31');
    expect(out.filter((h) => h.date.startsWith('2026'))).toHaveLength(0);
  });

  it('mixes configured + default years across a boundary span', () => {
    // 2026 configured (custom only), 2025/2027 fall back to defaults.
    const out = resolveHolidaysForRange(
      { '2026': [{ date: '2026-06-12', name: 'Outing' }] },
      '2026-01-01',
      '2026-01-31',
    );
    expect(has(out, '2026-06-12')).toBe(true); // configured 2026
    expect(has(out, '2025-12-25')).toBe(true); // default neighbour year
  });
});
