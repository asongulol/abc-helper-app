/**
 * Is this payment confirmed enough to finalize as 'reconciled'?
 *
 * The rule used to be "sent, has a paid_at, and either isn't a Wise payment or
 * carries a transfer id". A transfer ID is not a payment: the app writes one the
 * moment it DRAFTS a transfer it can never fund (ADR-0007), so a row could carry
 * an id for a transfer that was still waiting for money — or had been cancelled
 * — and the bulk button would stamp it reconciled. That is exactly how 29 rows
 * (₱413,770.03) came to sit behind a green tick pointing at transfers that never
 * sent.
 *
 * `wise_locked_at` is the difference. Only three paths set it — the poll, the
 * matcher's refresh, and a manual link — and all three set it ONLY after seeing
 * the transfer in a terminal paid state. So it means "Wise confirmed this money
 * left", which is the claim "reconciled" is making.
 */
export interface ReconcilableRow {
  status: string;
  paid_at?: string | null;
  payout_method?: string | null;
  wise_transfer_id?: string | null;
  wise_locked_at?: string | null;
}

/** A Wise row whose link has never been confirmed against a paid transfer. */
export const isUnconfirmedWiseLink = (row: ReconcilableRow): boolean =>
  row.payout_method === 'wise' && !!row.wise_transfer_id && !row.wise_locked_at;

/**
 * Ready to finalize. Non-Wise rows have nothing to confirm against — they are
 * paid by hand and `paid_at` is the whole record.
 */
export const isReadyToReconcile = (row: ReconcilableRow): boolean => {
  if (row.status !== 'sent' || !row.paid_at) return false;
  if (row.payout_method !== 'wise') return true;
  return !!row.wise_transfer_id && !!row.wise_locked_at;
};
