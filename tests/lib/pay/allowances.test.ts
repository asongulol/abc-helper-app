import { describe, expect, it } from 'vitest';
import { centavos } from '@/lib/money';
import {
  HA_ANNUAL,
  healthAllowance,
  monthsWorkedInYear,
  thirteenthAccrual,
} from '@/lib/pay/allowances';

describe('healthAllowance (legacy ~5864)', () => {
  it('pays the full ₱20,000 in the period containing the hire anniversary', () => {
    expect(healthAllowance('2024-03-10', '2026-03-01', '2026-03-15')).toBe(HA_ANNUAL);
    expect(healthAllowance('2024-03-10', '2026-03-16', '2026-03-31')).toBe(0);
    expect(healthAllowance('2024-03-10', '2026-04-01', '2026-04-15')).toBe(0);
  });

  it('returns 0 with no hire date', () => {
    expect(healthAllowance(null, '2026-03-01', '2026-03-15')).toBe(0);
    expect(healthAllowance(undefined, '2026-03-01', '2026-03-15')).toBe(0);
  });

  it('not yet eligible inside the first 180 days', () => {
    // Hired Jan 5 2026 → eligible Jul 4 2026; the Jan-anniversary period pays 0.
    expect(healthAllowance('2026-01-05', '2026-01-01', '2026-01-15')).toBe(0);
  });

  it('first anniversary after eligibility pays', () => {
    // Hired Jan 5 2026 → Jan 5 2027 anniversary is past the 180-day mark.
    expect(healthAllowance('2026-01-05', '2027-01-01', '2027-01-15')).toBe(HA_ANNUAL);
  });

  it('clamps a day-29+ hire day to the 28th (legacy min(day,28))', () => {
    // Hired Jan 31 → anniversary computed as Jan 28 → second-half period pays.
    expect(healthAllowance('2023-01-31', '2026-01-16', '2026-01-31')).toBe(HA_ANNUAL);
    expect(healthAllowance('2023-01-31', '2026-01-01', '2026-01-15')).toBe(0); // 28 > 15
  });

  it('anniversary day 16–28 lands in the second-half period', () => {
    expect(healthAllowance('2023-01-20', '2026-01-16', '2026-01-31')).toBe(HA_ANNUAL);
    expect(healthAllowance('2023-01-20', '2026-01-01', '2026-01-15')).toBe(0);
  });
});

/** Legacy float reference: +((mw/12)*rate).toFixed(2), rate in PHP major units. */
const legacyThirteenth = (mw: number, ratePhp: number): number => +((mw / 12) * ratePhp).toFixed(2);

describe('monthsWorkedInYear (legacy ~5880)', () => {
  it('full-year worker: Jan 1 → Jun 30 ≈ 5.9667 months', () => {
    expect(monthsWorkedInYear(null, '2026-06-30')).toBeCloseTo(5 + 29 / 30, 10);
  });

  it('uses the hire date when hired this year', () => {
    expect(monthsWorkedInYear('2026-03-15', '2026-06-30')).toBeCloseTo(3 + 15 / 30, 10);
  });

  it('ignores a prior-year hire date', () => {
    expect(monthsWorkedInYear('2024-09-01', '2026-06-30')).toBeCloseTo(5 + 29 / 30, 10);
  });

  it('clamps to [0, 12]', () => {
    expect(monthsWorkedInYear('2026-12-31', '2026-12-31')).toBe(0);
    expect(monthsWorkedInYear(null, '2026-12-31')).toBeLessThanOrEqual(12);
  });
});

describe('thirteenthAccrual — parity with the legacy float formula', () => {
  it('matches legacy to the centavo across representative rates/dates', () => {
    const cases: Array<[number, string | null, string]> = [
      [15000, null, '2026-06-30'],
      [12345.67, null, '2026-06-30'],
      [8000.5, '2026-03-15', '2026-06-30'],
      [20000, '2024-01-10', '2026-12-31'],
      [17500, '2026-02-01', '2026-11-15'],
    ];
    for (const [ratePhp, hire, end] of cases) {
      const mw = monthsWorkedInYear(hire, end);
      const expected = Math.round(legacyThirteenth(mw, ratePhp) * 100);
      const actual = thirteenthAccrual(centavos(Math.round(ratePhp * 100)), hire, end);
      expect(
        Math.abs(actual - expected),
        `rate=${ratePhp} hire=${hire} end=${end}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('returns 0 for a null/zero rate', () => {
    expect(thirteenthAccrual(null, null, '2026-06-30')).toBe(0);
    expect(thirteenthAccrual(centavos(0), null, '2026-06-30')).toBe(0);
  });
});
