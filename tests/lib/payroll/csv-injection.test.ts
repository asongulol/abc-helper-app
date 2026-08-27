/**
 * RP-62 — CSV formula injection across every CSV builder in the app.
 *
 * These files get opened in Excel/Sheets by an admin, where a cell starting with
 * = + - @ is executed. All of them share one escape (bank-export.ts), so the cases
 * below are really one guard exercised through each builder.
 *
 * The Reports and Invoicing screens build their CSVs inline in client components,
 * so what's covered here is `csvEscape` — the exact function both now map over
 * every cell — plus the two exported reports builders end to end.
 */

import { describe, expect, it } from 'vitest';
import { buildBankExport } from '@/lib/payroll/bank-export';
import { buildIndividualPayments } from '@/lib/payroll/individual-payments';
import { buildWiseBatch } from '@/lib/payroll/wise-batch';
import { buildPaymentDetailCsv, buildPeriodSummaryCsv, csvEscape } from '@/lib/reports/csv';

const FORMULAS = ['=1+1', '+A1', '-cmd', '@SUM(A1)'];
const opts = { periodStart: '2026-06-01', periodEnd: '2026-06-15' };

const bankLine = (name: string, netPhp = 12000) =>
  buildBankExport([{ name, netPhp, payoutMethod: 'bpi' }], opts).csv.split('\n')[1];

const individualLine = (name: string, netPhp = 12000) =>
  buildIndividualPayments(
    [{ name, payoutMethod: 'bpi', wiseRecipientId: null, email: null, netPhp }],
    { ...opts, payDate: '2026-06-15' },
  ).csv.split('\n')[1];

const wiseLine = (name: string, netPhp = 12000) =>
  buildWiseBatch(
    [
      {
        name,
        email: 'maria@example.com',
        netPhp,
        payoutMethod: 'wise',
        wiseRecipientUuid: '11111111-2222-3333-4444-555555555555',
      },
    ],
    opts,
  ).csv.split('\n')[1];

describe('RP-62 — text fields beginning with a formula character are neutralized', () => {
  for (const name of FORMULAS) {
    it(`neutralizes ${name} in every builder`, () => {
      expect(bankLine(name)).toBe(`'${name},bpi,,12000.00`);
      expect(individualLine(name)).toContain(`'${name},bpi`);
      expect(wiseLine(name)).toContain(`,'${name},`);
    });
  }

  it('quotes AND neutralizes when the formula also contains a comma', () => {
    expect(bankLine('=SUM(A1,B1)')).toBe(`"'=SUM(A1,B1)",bpi,,12000.00`);
  });

  it('leaves a normal name untouched', () => {
    expect(bankLine('Maria Dela Cruz')).toBe('Maria Dela Cruz,bpi,,12000.00');
    expect(individualLine('Maria Dela Cruz')).toBe(
      'Maria Dela Cruz,bpi,,,12000.00,2026-06-15,2026-06-01–2026-06-15',
    );
  });
});

describe('RP-62 — numbers are never prefixed (tools read these columns back)', () => {
  it('writes a negative amount as a plain number — a leading "-" must not be prefixed', () => {
    expect(bankLine('Maria Dela Cruz', -500)).toBe('Maria Dela Cruz,bpi,,-500.00');
    expect(individualLine('Maria Dela Cruz', -500)).toContain(',-500.00,');
  });

  it('keeps the Wise amount column numeric and the recipient UUID unquoted', () => {
    // Template parity: Wise re-reads these columns, so neither may be prefixed.
    // (A non-positive net never reaches this file at all — see RP-60 below.)
    expect(wiseLine('Maria Dela Cruz')).toBe(
      '11111111-2222-3333-4444-555555555555,Maria Dela Cruz,maria@example.com,,USD,PHP,target,12000,Payroll 2026-06-15,PERSON',
    );
  });
});

// --- Reports / Invoicing screens -------------------------------------------

const PAYMENT: Parameters<typeof buildPaymentDetailCsv>[0][number] = {
  paymentId: 'pay1',
  workerId: 'w1',
  workerName: 'Maria Dela Cruz',
  periodId: 'p1',
  periodStart: '2026-06-01',
  periodEnd: '2026-06-15',
  grossCentavos: 1000000,
  haCentavos: 25000,
  t13Centavos: 0,
  pddCentavos: 5000,
  bonusCentavos: 0,
  shortfallCentavos: 0,
  netCentavos: 1030000,
  payoutMethod: 'gcash',
  status: 'sent',
};

const PERIOD: Parameters<typeof buildPeriodSummaryCsv>[0][number] = {
  periodId: 'p1',
  periodStart: '2026-06-01',
  periodEnd: '2026-06-15',
  payDate: '2026-06-20',
  state: 'paid',
  totalGrossCentavos: 2000000,
  totalHaCentavos: 50000,
  totalT13Centavos: 0,
  totalNetCentavos: 2050000,
  contractorCount: 2,
};

const detailLine = (over: Partial<typeof PAYMENT>) =>
  buildPaymentDetailCsv([{ ...PAYMENT, ...over }]).split('\n')[1];

describe('RP-62 — reports CSV builders', () => {
  for (const name of FORMULAS) {
    it(`neutralizes ${name} in the worker column`, () => {
      expect(detailLine({ workerName: name })).toContain(`,'${name},`);
    });
  }

  it('leaves a normal row byte-identical', () => {
    expect(detailLine({})).toBe(
      '2026-06-01,2026-06-15,Maria Dela Cruz,10000.00,250.00,0.00,50.00,0.00,0.00,10300.00,gcash,sent',
    );
    expect(buildPeriodSummaryCsv([PERIOD]).split('\n')[1]).toBe(
      '2026-06-01,2026-06-15,2026-06-20,paid,2,20000.00,500.00,0.00,20500.00',
    );
  });

  it('keeps negative and decimal amounts unprefixed', () => {
    expect(detailLine({ netCentavos: -50000, bonusCentavos: -12345 })).toContain(',-123.45,');
    expect(detailLine({ netCentavos: -50000 })).toContain(',-500.00,gcash,');
    expect(buildPeriodSummaryCsv([{ ...PERIOD, totalNetCentavos: -50000 }])).toContain(',-500.00');
  });
});

describe('RP-62 — csvEscape (the escape both client screens map over every cell)', () => {
  it('neutralizes formulas and passes everything else through', () => {
    for (const name of FORMULAS) expect(csvEscape(name)).toBe(`'${name}`);
    expect(csvEscape('Maria Dela Cruz')).toBe('Maria Dela Cruz');
    expect(csvEscape('Cruz, Ana')).toBe('"Cruz, Ana"');
    expect(csvEscape(null)).toBe('');
  });

  it('leaves numeric cells alone (hours, rates, USD amounts, negatives)', () => {
    expect(csvEscape(-500)).toBe('-500');
    expect(csvEscape(-12.5)).toBe('-12.5');
    expect(csvEscape(0)).toBe('0');
    expect(csvEscape('-500.00')).toBe('-500.00');
  });
});
