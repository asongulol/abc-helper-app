import { describe, expect, it } from 'vitest';
import { centavos } from '@/lib/money';
import { calcContractorRow, miscTotal, usdReference } from '@/lib/pay/calc';
import { resolveRate } from '@/lib/pay/rates';

/** Legacy float reference for gross: ratio>=1 ? rate : +(ratio*rate).toFixed(2). */
const legacyGross = (ratePhp: number, ratio: number): number =>
  ratio >= 1 ? ratePhp : +(ratio * ratePhp).toFixed(2);

const PERIOD = { periodStart: '2026-06-01', periodEnd: '2026-06-15' }; // expected FT = 88h

describe('calcContractorRow (legacy calculate() ~6076)', () => {
  it('full hours pays exactly the rate — no overtime premium', () => {
    const r = calcContractorRow({
      workedSeconds: 88 * 3600,
      contract: 'FT',
      rate: centavos(1_500_000), // ₱15,000
      ...PERIOD,
    });
    expect(r.ratio).toBe(1);
    expect(r.gross).toBe(1_500_000);
    expect(r.shortfall).toBe(0);
    expect(r.net).toBe(1_500_000);
  });

  it('over-worked hours still pay the rate (capped)', () => {
    const r = calcContractorRow({
      workedSeconds: 120 * 3600,
      contract: 'FT',
      rate: centavos(1_500_000),
      ...PERIOD,
    });
    expect(r.gross).toBe(1_500_000);
  });

  it('under-worked hours prorate and record the informational shortfall', () => {
    const r = calcContractorRow({
      workedSeconds: 44 * 3600, // half of 88
      contract: 'FT',
      rate: centavos(1_500_000),
      ...PERIOD,
    });
    expect(r.ratio).toBeCloseTo(0.5, 10);
    expect(r.gross).toBe(750_000);
    expect(r.shortfall).toBe(750_000);
    expect(r.net).toBe(750_000);
  });

  it('matches the legacy float gross to the centavo across a sweep', () => {
    const rates = [15000, 12345.67, 8000.5, 20000, 17321.99];
    const hours = [10.5, 23.25, 44, 61.75, 80, 87.99];
    for (const ratePhp of rates) {
      for (const h of hours) {
        const ratio = Math.min(h / 88, 5);
        const expected = Math.round(legacyGross(ratePhp, ratio) * 100);
        const r = calcContractorRow({
          workedSeconds: Math.round(h * 3600),
          contract: 'FT',
          rate: centavos(Math.round(ratePhp * 100)),
          ...PERIOD,
        });
        expect(Math.abs((r.gross ?? 0) - expected), `rate=${ratePhp} h=${h}`).toBeLessThanOrEqual(
          1,
        );
      }
    }
  });

  it('null rate ⇒ null gross/net (row is excluded from payouts upstream)', () => {
    const r = calcContractorRow({
      workedSeconds: 80 * 3600,
      contract: 'FT',
      rate: null,
      ...PERIOD,
    });
    expect(r.gross).toBeNull();
    expect(r.net).toBeNull();
    expect(r.shortfall).toBe(0);
  });

  it('PTO seconds count as worked time (paid leave)', () => {
    const r = calcContractorRow({
      workedSeconds: 80 * 3600 + 8 * 3600, // 80 tracked + 8 PTO
      contract: 'FT',
      rate: centavos(1_500_000),
      ...PERIOD,
    });
    expect(r.ratio).toBe(1);
    expect(r.gross).toBe(1_500_000);
  });

  it('net = gross + HA + 13th + pdd + bonus + misc', () => {
    const r = calcContractorRow({
      workedSeconds: 88 * 3600,
      contract: 'FT',
      rate: centavos(1_500_000),
      hireDate: '2024-06-10',
      healthAllowanceEligible: true,
      thirteenthMonthEligible: true,
      pddLunch: centavos(50_000),
      bonus: centavos(100_000),
      miscItems: [
        { kind: 'other_earns', label: 'Referral', amount: 500 },
        { kind: 'deduction', label: 'Advance', amount: 200 },
      ],
      ...PERIOD,
    });
    expect(r.healthAllowance).toBe(2_000_000); // anniversary Jun 10 in period
    expect(r.thirteenth).toBeGreaterThan(0);
    expect(r.misc).toBe(30_000); // +500 − 200 PHP
    expect(r.net).toBe(1_500_000 + 2_000_000 + r.thirteenth + 50_000 + 100_000 + 30_000);
  });

  it('degenerate zero-expected period: positive work caps the ratio', () => {
    const r = calcContractorRow({
      workedSeconds: 3600,
      contract: 'FT',
      periodStart: '2026-06-06', // Sat
      periodEnd: '2026-06-07', // Sun → 0 weekdays
      rate: centavos(1_500_000),
    });
    expect(r.expectedHours).toBe(0);
    expect(r.ratio).toBe(5);
    expect(r.gross).toBe(1_500_000);
  });
});

describe('calcContractorRow — PH (per hour) / PS (per session)', () => {
  it('PH pays worked hours × the per-hour rate; no expected hours or ratio', () => {
    const r = calcContractorRow({
      workedSeconds: 10 * 3600,
      contract: 'PH',
      rate: centavos(50_000), // ₱500 / hour
      ...PERIOD,
    });
    expect(r.expectedHours).toBe(0);
    expect(r.ratio).toBe(0);
    expect(r.workedHours).toBe(10);
    expect(r.gross).toBe(500_000); // 10 × ₱500
    expect(r.shortfall).toBe(0);
    expect(r.rate).toBe(50_000);
    expect(r.net).toBe(500_000);
  });

  it('PH is cent-accurate on fractional hours (1.5h × ₱33.33 = ₱49.995 → ₱50.00)', () => {
    const r = calcContractorRow({
      workedSeconds: Math.round(1.5 * 3600),
      contract: 'PH',
      rate: centavos(3_333), // ₱33.33 / hour
      ...PERIOD,
    });
    expect(r.gross).toBe(5_000);
  });

  it('PS pays approved sessions × the per-session rate (duration ignored)', () => {
    const r = calcContractorRow({
      workedSeconds: 0,
      sessionUnits: 12,
      contract: 'PS',
      rate: centavos(40_000), // ₱400 / session
      ...PERIOD,
    });
    expect(r.expectedHours).toBe(0);
    expect(r.gross).toBe(480_000); // 12 × ₱400
    expect(r.rate).toBe(40_000);
    expect(r.net).toBe(480_000);
  });

  it('PS with no sessions ⇒ zero gross', () => {
    const r = calcContractorRow({
      workedSeconds: 0,
      sessionUnits: 0,
      contract: 'PS',
      rate: centavos(40_000),
      ...PERIOD,
    });
    expect(r.gross).toBe(0);
    expect(r.net).toBe(0);
  });

  it('per-unit contracts get no 13th-month accrual even if flagged eligible', () => {
    const r = calcContractorRow({
      workedSeconds: 8 * 3600,
      contract: 'PH',
      rate: centavos(50_000),
      hireDate: '2024-01-01',
      thirteenthMonthEligible: true,
      includeThirteenth: true,
      ...PERIOD,
    });
    expect(r.thirteenth).toBe(0);
  });

  it('null rate ⇒ null gross for PH/PS too', () => {
    const r = calcContractorRow({ workedSeconds: 5 * 3600, contract: 'PH', rate: null, ...PERIOD });
    expect(r.gross).toBeNull();
    expect(r.net).toBeNull();
  });
});

describe('calcContractorRow — PHS (shared-prod per hour / session via pay_basis)', () => {
  it("PHS + pay_basis='hourly' is identical to legacy PH", () => {
    const phs = calcContractorRow({
      workedSeconds: 10 * 3600,
      contract: 'PHS',
      payBasis: 'hourly',
      rate: centavos(50_000),
      ...PERIOD,
    });
    const ph = calcContractorRow({
      workedSeconds: 10 * 3600,
      contract: 'PH',
      rate: centavos(50_000),
      ...PERIOD,
    });
    expect(phs.gross).toBe(ph.gross); // 500_000
    expect(phs.expectedHours).toBe(0);
    expect(phs.ratio).toBe(0);
    expect(phs.shortfall).toBe(0);
    expect(phs.net).toBe(500_000);
    expect(phs.payBasisUnset).toBe(false);
  });

  it("PHS + pay_basis='per_session' is identical to legacy PS", () => {
    const phs = calcContractorRow({
      workedSeconds: 0,
      sessionUnits: 12,
      contract: 'PHS',
      payBasis: 'per_session',
      rate: centavos(40_000),
      ...PERIOD,
    });
    const ps = calcContractorRow({
      workedSeconds: 0,
      sessionUnits: 12,
      contract: 'PS',
      rate: centavos(40_000),
      ...PERIOD,
    });
    expect(phs.gross).toBe(ps.gross); // 480_000
    expect(phs.net).toBe(480_000);
    expect(phs.payBasisUnset).toBe(false);
  });

  it('PHS with an UNSET pay_basis is paid NOTHING (never worked×rate) and is flagged', () => {
    const r = calcContractorRow({
      workedSeconds: 40 * 3600, // would be ₱20k if mis-paid hourly
      sessionUnits: 0,
      contract: 'PHS',
      payBasis: null,
      rate: centavos(50_000),
      ...PERIOD,
    });
    expect(r.gross).toBeNull(); // safety: no silent salary→hourly conversion
    expect(r.net).toBeNull();
    expect(r.payBasisUnset).toBe(true);
  });

  it('PHS with an INVALID pay_basis is also treated as unset (unpayable)', () => {
    const r = calcContractorRow({
      workedSeconds: 8 * 3600,
      contract: 'PHS',
      payBasis: 'weekly', // not 'hourly' | 'per_session'
      rate: centavos(50_000),
      ...PERIOD,
    });
    expect(r.gross).toBeNull();
    expect(r.payBasisUnset).toBe(true);
  });

  it('PHS gets no 13th-month accrual even if flagged eligible', () => {
    const r = calcContractorRow({
      workedSeconds: 8 * 3600,
      contract: 'PHS',
      payBasis: 'hourly',
      rate: centavos(50_000),
      hireDate: '2024-01-01',
      thirteenthMonthEligible: true,
      includeThirteenth: true,
      ...PERIOD,
    });
    expect(r.thirteenth).toBe(0);
  });
});

describe('miscTotal (legacy ~6369)', () => {
  it('deduction kind subtracts; others add; junk counts 0', () => {
    expect(
      miscTotal([
        { kind: 'other_earns', amount: 1000 },
        { kind: 'other_hours', amount: '250.50' },
        { kind: 'deduction', amount: 300 },
        { kind: 'other_earns', amount: 'not-a-number' },
      ]),
    ).toBe(95_050);
    expect(miscTotal(null)).toBe(0);
    expect(miscTotal([])).toBe(0);
  });
});

describe('resolveRate (legacy rateFor ~6160)', () => {
  const rows = [
    {
      workerId: 'w1',
      amountPhp: '14000.00',
      effectiveStart: '2025-01-01',
      effectiveEnd: '2025-12-31',
    },
    {
      workerId: 'w1',
      amountPhp: '15000.00',
      effectiveStart: '2026-01-01',
      effectiveEnd: null,
    },
    {
      workerId: 'w2',
      amountPhp: '9000.00',
      effectiveStart: '2026-07-01',
      effectiveEnd: null,
    },
  ];

  it('picks the most recent rate overlapping the period', () => {
    expect(resolveRate(rows, 'w1', '2026-06-01', '2026-06-15')).toBe(1_500_000);
    expect(resolveRate(rows, 'w1', '2025-06-01', '2025-06-15')).toBe(1_400_000);
  });

  it('a future-dated rate does not apply yet', () => {
    expect(resolveRate(rows, 'w2', '2026-06-01', '2026-06-15')).toBeNull();
  });

  it('unknown worker ⇒ null', () => {
    expect(resolveRate(rows, 'w9', '2026-06-01', '2026-06-15')).toBeNull();
  });

  it('a rate starting mid-period applies (effective_start <= periodEnd)', () => {
    expect(resolveRate(rows, 'w2', '2026-06-20', '2026-07-05')).toBe(900_000);
  });
});

describe('usdReference', () => {
  it('converts net centavos at PHP-per-USD fx into USD cents', () => {
    expect(usdReference(centavos(1_500_000), 58)).toBe(25_862); // ₱15,000 / 58 ≈ $258.62
    expect(usdReference(null, 58)).toBeNull();
    expect(usdReference(centavos(1_500_000), 0)).toBeNull();
  });
});
