import { describe, expect, it } from 'vitest';
import { buildBankExport } from '../../../src/lib/payroll/bank-export';

const rows = [
  { name: 'Juan dela Cruz', netPhp: 19140.0, payoutMethod: 'bpi' },
  { name: 'Maria, "Smith"', netPhp: 10000.5, payoutMethod: 'gcash' },
  { name: 'Wise Worker', netPhp: 5000.0, payoutMethod: 'wise' },
];

describe('buildBankExport', () => {
  it('filters out wise rows by default', () => {
    const { csv } = buildBankExport(rows, { periodStart: '2026-06-01', periodEnd: '2026-06-15' });
    expect(csv).toContain('Juan dela Cruz');
    expect(csv).toContain('Maria');
    expect(csv).not.toContain('Wise Worker');
  });

  it('includes wise rows when includeWise=true', () => {
    const { csv } = buildBankExport(rows, {
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
      includeWise: true,
    });
    expect(csv).toContain('Wise Worker');
  });

  it('formats net to 2 decimal places', () => {
    const { csv } = buildBankExport(rows, { periodStart: '2026-06-01', periodEnd: '2026-06-15' });
    expect(csv).toContain('19140.00');
    expect(csv).toContain('10000.50');
  });

  it('escapes commas and quotes in names (RFC 4180: wrap in quotes, double inner quotes)', () => {
    const { csv } = buildBankExport(rows, { periodStart: '2026-06-01', periodEnd: '2026-06-15' });
    expect(csv).toContain('"Maria, ""Smith"""');
  });

  it('uses correct filename', () => {
    const { filename } = buildBankExport(rows, {
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
    });
    expect(filename).toBe('payroll-2026-06-01-to-2026-06-15.csv');
  });

  it('includes header row', () => {
    const { csv } = buildBankExport(rows, { periodStart: '2026-06-01', periodEnd: '2026-06-15' });
    expect(csv.startsWith('Name,Bank,Account,Amount (PHP)')).toBe(true);
  });
});
