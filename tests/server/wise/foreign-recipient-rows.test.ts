import { describe, expect, it } from 'vitest';
import { type DraftPaymentRow, foreignRecipientRows } from '@/lib/wise/draft-row';

// RP-54: a per-row recipientId override must be one of THAT worker's recipients.
const row = (over: Partial<DraftPaymentRow['workers']> = {}): DraftPaymentRow => ({
  id: 'p1',
  net_php: 48000,
  workers: {
    wise_recipient_id: 555,
    wise_recipients: [
      { id: 555, label: 'BPI' },
      { id: 556, label: 'GCash' },
    ],
    first_name: 'Maria',
    last_name: 'Dela Cruz',
    ...over,
  },
});

describe('foreignRecipientRows (Wise batch recipient ownership)', () => {
  it('accepts the worker default and any recipient on their saved list', () => {
    expect(foreignRecipientRows([{ paymentId: 'p1', recipientId: 555 }], [row()])).toEqual([]);
    expect(foreignRecipientRows([{ paymentId: 'p1', recipientId: 556 }], [row()])).toEqual([]);
  });

  it('accepts the default even when the saved list is empty or missing', () => {
    const bare = row({ wise_recipients: null });
    expect(foreignRecipientRows([{ paymentId: 'p1', recipientId: 555 }], [bare])).toEqual([]);
  });

  it('flags another worker`s recipient, naming the contractor', () => {
    expect(foreignRecipientRows([{ paymentId: 'p1', recipientId: 999 }], [row()])).toEqual([
      { paymentId: 'p1', recipientId: 999, name: 'Maria Dela Cruz' },
    ]);
  });

  it('ignores rows with no override — those use the saved default', () => {
    expect(foreignRecipientRows([{ paymentId: 'p1' }], [row()])).toEqual([]);
    expect(foreignRecipientRows([{ paymentId: 'p1', recipientId: undefined }], [row()])).toEqual(
      [],
    );
  });

  it('ignores a payment the query did not return (the draft layer skips it)', () => {
    expect(foreignRecipientRows([{ paymentId: 'nope', recipientId: 999 }], [row()])).toEqual([]);
  });

  it('flags an override when the worker has no recipients at all', () => {
    const none: DraftPaymentRow = { id: 'p1', net_php: 1000, workers: null };
    expect(foreignRecipientRows([{ paymentId: 'p1', recipientId: 1 }], [none])).toEqual([
      { paymentId: 'p1', recipientId: 1, name: 'that contractor' },
    ]);
  });
});
