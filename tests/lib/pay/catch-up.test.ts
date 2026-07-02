import { describe, expect, it } from 'vitest';
import { centavos, mulRatioMinor } from '@/lib/money';
import { salariedCatchUpAmount } from '@/lib/pay/catch-up';

// June 1–15 2026 has 88 expected FT hours (11 weekdays × 8h, no holidays) —
// same period the off-cycle tests use.
const RATE = centavos(1_500_000); // ₱15,000.00
const EXPECTED = 88;

const amount = (paid: number, caught: number, leftover: number) =>
  salariedCatchUpAmount({
    rate: RATE,
    expectedHours: EXPECTED,
    paidHours: paid,
    caughtUpHours: caught,
    leftoverHours: leftover,
  });

describe('salariedCatchUpAmount', () => {
  it('partial → partial: engine-diff of the two capped grosses', () => {
    expect(amount(60, 0, 20)).toBe(
      mulRatioMinor(RATE, 80 / EXPECTED) - mulRatioMinor(RATE, 60 / EXPECTED),
    );
  });

  it('crossing the cap tops up exactly to the rate', () => {
    expect(amount(80, 0, 20)).toBe(RATE - mulRatioMinor(RATE, 80 / EXPECTED));
  });

  it('already at or above the cap ⇒ 0 (strict engine cap)', () => {
    expect(amount(88, 0, 10)).toBe(0);
    expect(amount(100, 0, 10)).toBe(0);
  });

  it('zero leftover ⇒ 0', () => {
    expect(amount(60, 0, 0)).toBe(0);
  });

  it('already-caught-up hours shift the base; snapshots are additive', () => {
    expect(amount(60, 10, 30)).toBe(RATE - mulRatioMinor(RATE, 70 / EXPECTED));
    // Two catch-ups equal one big one — no centavo gained or lost by splitting.
    expect((amount(60, 0, 10) ?? 0) + (amount(60, 10, 30) ?? 0)).toBe(amount(60, 0, 40));
  });

  it('null rate ⇒ null', () => {
    expect(
      salariedCatchUpAmount({
        rate: null,
        expectedHours: EXPECTED,
        paidHours: 0,
        caughtUpHours: 0,
        leftoverHours: 8,
      }),
    ).toBeNull();
  });

  it('expected 0 mirrors the engine degenerate branch', () => {
    const degenerate = (paid: number, leftover: number) =>
      salariedCatchUpAmount({
        rate: RATE,
        expectedHours: 0,
        paidHours: paid,
        caughtUpHours: 0,
        leftoverHours: leftover,
      });
    expect(degenerate(0, 8)).toBe(RATE); // any positive hours ⇒ full rate
    expect(degenerate(4, 8)).toBe(0); // already paid the (capped) full rate
  });

  it('rounding exactness: before + amount === after, per engine rounding', () => {
    const before = mulRatioMinor(RATE, 61.37 / EXPECTED);
    const after = mulRatioMinor(RATE, (61.37 + 13.9) / EXPECTED);
    expect(before + (amount(61.37, 0, 13.9) ?? 0)).toBe(after);
  });
});
