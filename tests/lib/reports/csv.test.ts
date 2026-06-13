import { buildPaymentDetailCsv, buildPeriodSummaryCsv } from '@/lib/reports/csv';
import { describe, expect, it } from 'vitest';

const PERIOD: Parameters<typeof buildPeriodSummaryCsv>[0][number] = {
  periodId: 'p1',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-15',
  payDate: '2026-01-20',
  state: 'paid',
  totalGrossCentavos: 2000000,
  totalHaCentavos: 50000,
  totalT13Centavos: 0,
  totalNetCentavos: 2050000,
  contractorCount: 2,
};

const PAYMENT: Parameters<typeof buildPaymentDetailCsv>[0][number] = {
  paymentId: 'pay1',
  workerId: 'w1',
  workerName: 'Juan Dela Cruz',
  periodId: 'p1',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-15',
  grossCentavos: 1000000,
  haCentavos: 25000,
  t13Centavos: 0,
  pddCentavos: 5000,
  bonusCentavos: 0,
  dedCentavos: 0,
  netCentavos: 1030000,
  payoutMethod: 'gcash',
  status: 'sent',
};

describe('buildPeriodSummaryCsv', () => {
  it('has a header row', () => {
    const csv = buildPeriodSummaryCsv([PERIOD]);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('Period Start');
    expect(lines[0]).toContain('Net PHP');
  });

  it('outputs major unit values (divides centavos by 100)', () => {
    const csv = buildPeriodSummaryCsv([PERIOD]);
    const lines = csv.split('\n');
    // 2000000 centavos = 20000.00 PHP
    expect(lines[1]).toContain('20000.00');
    // 2050000 centavos = 20500.00 PHP
    expect(lines[1]).toContain('20500.00');
  });

  it('returns only header for empty input', () => {
    const csv = buildPeriodSummaryCsv([]);
    expect(csv.split('\n')).toHaveLength(1);
  });

  it('has correct contractor count', () => {
    const csv = buildPeriodSummaryCsv([PERIOD]);
    const lines = csv.split('\n');
    expect(lines[1]).toContain('2');
  });
});

describe('buildPaymentDetailCsv', () => {
  it('has a header row', () => {
    const csv = buildPaymentDetailCsv([PAYMENT]);
    expect(csv.split('\n')[0]).toContain('Worker');
    expect(csv.split('\n')[0]).toContain('Net PHP');
  });

  it('includes worker name', () => {
    const csv = buildPaymentDetailCsv([PAYMENT]);
    expect(csv).toContain('Juan Dela Cruz');
  });

  it('outputs net in major units', () => {
    const csv = buildPaymentDetailCsv([PAYMENT]);
    // 1030000 centavos = 10300.00
    expect(csv).toContain('10300.00');
  });

  it('escapes commas in worker names', () => {
    const payment = { ...PAYMENT, workerName: 'Cruz, Ana' };
    const csv = buildPaymentDetailCsv([payment]);
    expect(csv).toContain('"Cruz, Ana"');
  });
});
