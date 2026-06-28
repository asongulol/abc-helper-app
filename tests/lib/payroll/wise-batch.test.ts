import { describe, expect, it } from 'vitest';
import { buildWiseBatch, type WiseBatchRow } from '@/lib/payroll/wise-batch';

const row = (over: Partial<WiseBatchRow>): WiseBatchRow => ({
  name: 'Maria Dela Cruz',
  email: 'maria@example.com',
  netPhp: 12000,
  payoutMethod: 'wise',
  wiseRecipientUuid: '11111111-2222-3333-4444-555555555555',
  ...over,
});

describe('buildWiseBatch', () => {
  it('includes ONLY wise rows — never BPI or other methods', () => {
    const { included, csv } = buildWiseBatch(
      [
        row({ name: 'Wise One' }),
        row({ name: 'Bpi One', payoutMethod: 'bpi' }),
        row({ name: 'Gcash One', payoutMethod: 'gcash' }),
        row({ name: 'No Method', payoutMethod: null }),
      ],
      { periodStart: '2026-06-01', periodEnd: '2026-06-15' },
    );
    expect(included.map((r) => r.name)).toEqual(['Wise One']);
    expect(csv).toContain('Wise One');
    expect(csv).not.toContain('Bpi One');
    expect(csv).not.toContain('Gcash One');
    expect(csv).not.toContain('No Method');
  });

  it('drops wise rows missing a recipient UUID (returns them in `dropped`)', () => {
    const { included, dropped } = buildWiseBatch(
      [
        row({ name: 'Has UUID' }),
        row({ name: 'No UUID', wiseRecipientUuid: null }),
        row({ name: 'Empty UUID', wiseRecipientUuid: '' }),
      ],
      { periodStart: '2026-06-01', periodEnd: '2026-06-15' },
    );
    expect(included.map((r) => r.name)).toEqual(['Has UUID']);
    expect(dropped.map((r) => r.name)).toEqual(['No UUID', 'Empty UUID']);
  });

  it('emits the 10-column Wise template with USD→PHP and the recipient UUID first', () => {
    const { csv, filename } = buildWiseBatch([row({ netPhp: 12000.5 })], {
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
    });
    const [header, line] = csv.split('\n');
    expect(header).toBe(
      'recipientId,name,recipientEmail,recipientDetail,sourceCurrency,targetCurrency,amountCurrency,amount,paymentReference,receiverType',
    );
    expect(line).toBe(
      '11111111-2222-3333-4444-555555555555,Maria Dela Cruz,maria@example.com,,USD,PHP,target,12000.50,Payroll 2026-06-15,PERSON',
    );
    expect(filename).toBe('wise_batch_2026-06-01_to_2026-06-15.csv');
  });

  it('formats whole amounts without trailing .00 and quotes fields with commas', () => {
    const { csv } = buildWiseBatch([row({ name: 'Cruz, Maria', netPhp: 12000 })], {
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
    });
    const line = csv.split('\n')[1];
    expect(line).toContain('"Cruz, Maria"');
    expect(line).toContain(',12000,'); // no .00
  });
});
