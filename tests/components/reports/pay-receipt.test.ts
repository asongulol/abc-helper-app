import { describe, expect, it, vi } from 'vitest';

// ReportsClient pulls in the reports server actions (Supabase client + env
// validation) at module load. receiptModel is pure, so placeholders suffice.
vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key-0000000000000000');
vi.stubEnv('SUPABASE_SERVICE_KEY', 'test-service-key-0000000000000000');

const { receiptModel } = await import('@/components/reports/ReportsClient');
type Row = Parameters<typeof receiptModel>[0];

const base: Row = {
  start: '2026-08-01',
  end: '2026-08-15',
  worked: 81.05,
  pto: 0,
  hasPay: true,
  days: [],
  ha: 0,
  lunch: 0,
  t13: 0,
  gross: 28054.69,
  net: 28054.69,
  method: null,
  status: 'sent',
  workedPay: 81.05,
  expected: 86.67,
  ratio: null,
  rate: 30000,
  computedGross: null,
  bonus: 0,
  offCycle: 0,
  misc: [],
  units: null,
  perSession: false,
  fx: null,
  payout: null,
  payoutCur: null,
  note: null,
};

describe('receiptModel — the "how this pay was computed" breakdown', () => {
  it('salaried: shows the ratio formula when stored inputs reproduce the gross', () => {
    const m = receiptModel(base);
    expect(m.basis).toContain('81.05 h ÷ 86.67 h expected');
    expect(m.basis).toContain('93.5%');
    expect(m.extras).toEqual([]);
  });

  it('salaried at/over 100%: reads as full period rate', () => {
    const m = receiptModel({ ...base, workedPay: 90, gross: 30000, net: 30000 });
    expect(m.basis).toContain('full period rate');
  });

  it('drops the formula (no false "=") when stored gross does not match', () => {
    const m = receiptModel({ ...base, gross: 20000, net: 20000 });
    expect(m.basis).toBeNull();
  });

  it('per-hour and per-session word the basis by unit', () => {
    const ph = receiptModel({
      ...base,
      expected: null,
      units: 10,
      rate: 350,
      gross: 3500,
      net: 3500,
    });
    expect(ph.basis).toBe('10.00 h × PHP 350.00 per hour');
    const ps = receiptModel({
      ...base,
      expected: null,
      units: 4,
      rate: 2000,
      perSession: true,
      gross: 8000,
      net: 8000,
    });
    expect(ps.basis).toBe('4.00 sessions × PHP 2,000.00 per session');
  });

  it('never lists zero components (not everyone is entitled to them)', () => {
    const m = receiptModel({ ...base, ha: 1500, net: 29554.69 });
    expect(m.extras).toEqual([['Health allowance', 1500]]);
  });

  it('misc items pass through signed (deductions already negative)', () => {
    const m = receiptModel({
      ...base,
      misc: [{ label: 'Laptop deduction', amount: -2000 }],
      net: 26054.69,
    });
    expect(m.extras).toEqual([['Laptop deduction', -2000]]);
  });

  it('a manually adjusted gross shows the computed value plus the delta', () => {
    const m = receiptModel({ ...base, computedGross: 28054.69, gross: 28500, net: 28500 });
    expect(m.gross).toBe(28054.69);
    expect(m.extras[0][0]).toBe('Manual gross adjustment');
    expect(m.extras[0][1]).toBeCloseTo(445.31, 2);
  });

  it('components that do not reach the stored net get an unattributed line', () => {
    const m = receiptModel({ ...base, net: 28154.69 });
    expect(m.extras).toEqual([['Unattributed difference', expect.closeTo(100, 2)]]);
  });

  it('extras always sum from gross to the stored net', () => {
    const m = receiptModel({
      ...base,
      ha: 1500,
      t13: 2500,
      misc: [{ label: 'Referral bonus', amount: 1000 }],
      computedGross: 28054.69,
      gross: 28000,
      net: 33012.34,
    });
    const total = m.gross + m.extras.reduce((s, [, v]) => s + v, 0);
    expect(total).toBeCloseTo(33012.34, 2);
  });

  it('paid line renders only when payout + fx exist', () => {
    expect(receiptModel(base).paid).toBeNull();
    const m = receiptModel({ ...base, payout: 495.12, fx: 56.68, method: 'wise_api' });
    expect(m.paid).toContain('$495.12');
    expect(m.paid).toContain('₱56.68 / $1');
  });
});
