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

describe('buildWiseBatch — a zero net never reaches the file (RP-60)', () => {
  const opts = { periodStart: '2026-06-01', periodEnd: '2026-06-15' };

  it('drops a zero-net row — Wise rejects amount 0, sometimes the whole upload', () => {
    // Lock refuses a null or negative net, but zero passes; the API path already
    // skips it (`triageDraftRow`: "no amount") and the manual file now agrees.
    const { included, dropped, csv } = buildWiseBatch(
      [row({ name: 'Pays 12000' }), row({ name: 'Pays Nothing', netPhp: 0 })],
      opts,
    );
    expect(included.map((r) => r.name)).toEqual(['Pays 12000']);
    expect(csv).not.toContain('Pays Nothing');
    expect(dropped.map((d) => [d.name, d.reason])).toEqual([['Pays Nothing', 'no amount']]);
  });

  it('drops a negative net too, and says why per row rather than lumping them', () => {
    const { dropped } = buildWiseBatch(
      [row({ name: 'Negative', netPhp: -500 }), row({ name: 'No UUID', wiseRecipientUuid: null })],
      opts,
    );
    expect(dropped.map((d) => d.reason)).toEqual(['no amount', 'no Wise recipient UUID']);
  });

  it('still writes a row worth centavos — the guard is > 0, not >= 1 peso', () => {
    const { included } = buildWiseBatch([row({ name: 'Tiny', netPhp: 0.01 })], opts);
    expect(included.map((r) => r.name)).toEqual(['Tiny']);
  });
});

describe('buildWiseBatch — target currency must be PHP (RP-02)', () => {
  it('throws on a non-PHP target instead of denominating peso amounts as dollars', () => {
    // amountCurrency is 'target' and amount is netPhp, so a USD target would
    // send ₱50,000 as $50,000 — roughly 58x, on every row in the file.
    expect(() =>
      buildWiseBatch([row({ netPhp: 50000 })], {
        periodStart: '2026-06-01',
        periodEnd: '2026-06-15',
        targetCurrency: 'USD',
      }),
    ).toThrow(/must be PHP/);
  });

  it('still builds with an explicit PHP target and with the default', () => {
    const opts = { periodStart: '2026-06-01', periodEnd: '2026-06-15' };
    expect(buildWiseBatch([row({})], { ...opts, targetCurrency: 'PHP' }).included).toHaveLength(1);
    expect(buildWiseBatch([row({})], opts).included).toHaveLength(1);
  });
});
