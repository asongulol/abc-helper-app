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

  it('weekend holidays do NOT reduce expected', () => {
    // 2026-07-01..15: Jul 4 lands on a Saturday → no reduction; 11 weekdays.
    expect(expectedHours('FT', '2026-07-01', '2026-07-15')).toBe(88);
  });

  it('custom holiday list overrides the default', () => {
    expect(
      expectedHours('FT', '2026-06-01', '2026-06-15', [
        { name: 'Company day', date: '2026-06-03' },
      ]),
    ).toBe(80);
  });
});
