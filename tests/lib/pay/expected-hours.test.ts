import { describe, expect, it } from 'vitest';
import { expectedHours } from '@/lib/pay/expected-hours';

describe('expectedHours (legacy ~5852)', () => {
  it('FT: weekdays × 8, no holidays', () => {
    // 2026-06-01..15: 11 weekdays, no observed holidays.
    expect(expectedHours('FT', '2026-06-01', '2026-06-15')).toBe(88);
  });

  it('PT: weekdays × 4', () => {
    expect(expectedHours('PT', '2026-06-01', '2026-06-15')).toBe(44);
  });

  it('anything that is not exactly "PT" counts as FT (legacy rule)', () => {
    expect(expectedHours('full-time', '2026-06-01', '2026-06-15')).toBe(88);
  });

  it('weekday holidays reduce by one day each', () => {
    // 2026-12-16..31: 12 weekdays, Christmas (Fri) observed → 11 × 8.
    expect(expectedHours('FT', '2026-12-16', '2026-12-31')).toBe(88);
  });

  it('weekend holidays reduce expected on their observed working day', () => {
    // 2026-07-01..15: Jul 4 is a Saturday → observed Fri Jul 3; 11 weekdays − 1.
    expect(expectedHours('FT', '2026-07-01', '2026-07-15')).toBe(80);
  });

  it('a New-Year observance crossing the year boundary reduces December', () => {
    // 2028-01-01 is a Saturday → observed Fri 2027-12-31, inside this window.
    // 2027-12-16..31: 12 weekdays, less Christmas (Sat → observed Fri 12-24)
    // and New Year's (observed Fri 12-31) → 10 × 8.
    expect(expectedHours('FT', '2027-12-16', '2027-12-31')).toBe(80);
  });

  it('custom holiday list overrides the default', () => {
    expect(
      expectedHours('FT', '2026-06-01', '2026-06-15', [
        { name: 'Company day', date: '2026-06-03' },
      ]),
    ).toBe(80);
  });
});
