import { describe, expect, it } from 'vitest';
import { MarkInvoicePaidSchema } from '@/types/schemas/invoicing';

const VALID_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('MarkInvoicePaidSchema', () => {
  it('accepts a well-formed receipt', () => {
    const r = MarkInvoicePaidSchema.safeParse({
      invoiceId: VALID_UUID,
      amountReceivedUsd: 1234.56,
      receivedOn: '2026-06-20',
      paymentRef: 'WISE-001',
    });
    expect(r.success).toBe(true);
  });

  it('treats paymentRef as optional and trims it', () => {
    const r = MarkInvoicePaidSchema.safeParse({
      invoiceId: VALID_UUID,
      amountReceivedUsd: 0,
      receivedOn: '2026-06-20',
      paymentRef: '  ref  ',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.paymentRef).toBe('ref');

    const noRef = MarkInvoicePaidSchema.safeParse({
      invoiceId: VALID_UUID,
      amountReceivedUsd: 10,
      receivedOn: '2026-06-20',
    });
    expect(noRef.success).toBe(true);
  });

  it('rejects a negative amount', () => {
    expect(
      MarkInvoicePaidSchema.safeParse({
        invoiceId: VALID_UUID,
        amountReceivedUsd: -1,
        receivedOn: '2026-06-20',
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed date and a non-uuid id', () => {
    expect(
      MarkInvoicePaidSchema.safeParse({
        invoiceId: VALID_UUID,
        amountReceivedUsd: 10,
        receivedOn: '06/20/2026',
      }).success,
    ).toBe(false);
    expect(
      MarkInvoicePaidSchema.safeParse({
        invoiceId: 'not-a-uuid',
        amountReceivedUsd: 10,
        receivedOn: '2026-06-20',
      }).success,
    ).toBe(false);
  });
});
