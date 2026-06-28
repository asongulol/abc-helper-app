import { describe, expect, it } from 'vitest';
import {
  buildIndividualPayments,
  type IndividualPaymentRow,
} from '@/lib/payroll/individual-payments';

const row = (over: Partial<IndividualPaymentRow>): IndividualPaymentRow => ({
  name: 'Maria Dela Cruz',
  payoutMethod: 'wise',
  wiseRecipientId: 712515684,
  email: 'maria@example.com',
  netPhp: 12000,
  ...over,
});

describe('buildIndividualPayments', () => {
  it('includes EVERY method (wise, bpi, others) — full record', () => {
    const { csv, count } = buildIndividualPayments(
      [
        row({ name: 'Wise One' }),
        row({ name: 'Bpi One', payoutMethod: 'bpi', wiseRecipientId: null }),
      ],
      { payDate: '2026-06-15', periodStart: '2026-06-01', periodEnd: '2026-06-15' },
    );
    expect(count).toBe(2);
    expect(csv).toContain('Wise One');
    expect(csv).toContain('Bpi One');
  });

  it('emits the 7-column header and 2dp amounts with the period range', () => {
    const { csv, filename } = buildIndividualPayments([row({ netPhp: 12000 })], {
      payDate: '2026-06-15',
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
    });
    const [header, line] = csv.split('\n');
    expect(header).toBe('Contractor,Method,Wise recipient id,Email,Amount PHP,Pay date,Period');
    expect(line).toBe(
      'Maria Dela Cruz,wise,712515684,maria@example.com,12000.00,2026-06-15,2026-06-01–2026-06-15',
    );
    expect(filename).toBe('payments_2026-06-01_to_2026-06-15.csv');
  });

  it('leaves recipient id / email blank when absent and quotes commas', () => {
    const { csv } = buildIndividualPayments(
      [row({ name: 'Cruz, Maria', payoutMethod: 'bpi', wiseRecipientId: null, email: null })],
      { payDate: null, periodStart: '2026-06-01', periodEnd: '2026-06-15' },
    );
    const line = csv.split('\n')[1];
    expect(line).toBe('"Cruz, Maria",bpi,,,12000.00,,2026-06-01–2026-06-15');
  });
});
