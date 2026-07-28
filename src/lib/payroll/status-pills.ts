/**
 * Status pill tone mapping — and the payment-status predicates the pay screens
 * key their actions off. Pure: no DB, no React.
 */

import type { BadgeTone } from '@/components/ui/Badge';

/** Mirrors the `payment_status` enum; kept local so this module stays DB-free. */
export type PaymentStatus = 'draft' | 'queued' | 'sent' | 'failed' | 'reconciled';

export const periodStateTone = (state: 'open' | 'locked' | 'paid'): BadgeTone => {
  if (state === 'paid') return 'good';
  if (state === 'locked') return 'neutral';
  return 'warn';
};

export const periodStateLabel = (state: 'open' | 'locked' | 'paid'): string => {
  if (state === 'paid') return 'paid';
  if (state === 'locked') return 'locked';
  return 'draft';
};

export const paymentStatusTone = (status: PaymentStatus): BadgeTone => {
  if (status === 'sent' || status === 'reconciled') return 'good';
  if (status === 'failed') return 'bad';
  if (status === 'queued') return 'warn';
  return 'neutral';
};

export const paymentStatusLabel = (status: PaymentStatus): string => {
  if (status === 'sent') return 'paid';
  if (status === 'reconciled') return 'reconciled';
  if (status === 'queued') return 'queued';
  if (status === 'failed') return 'failed';
  return 'unpaid';
};

/**
 * Is this row still awaiting payment? Only these three states may be flipped by
 * "Mark paid": `sent` and `reconciled` have already moved money, so re-marking
 * them regresses the row and overwrites its true send date (RP-08).
 */
export const isUnpaidStatus = (status: PaymentStatus): boolean =>
  status === 'draft' || status === 'queued' || status === 'failed';

/**
 * A Wise draft transfer exists but nobody has funded it yet, so no money has
 * moved — "Mark all paid" must say so rather than flip these to a green
 * "paid" badge (RP-58).
 */
export const isUnfundedWiseDraft = (row: {
  status: PaymentStatus;
  payoutMethod: string | null;
  wiseTransferId: string | null;
}): boolean => row.payoutMethod === 'wise' && !!row.wiseTransferId && isUnpaidStatus(row.status);

export const payoutMethodLabel = (method: string | null): string => {
  if (method === 'wise') return 'Wise';
  if (method === 'bpi') return 'BPI';
  if (method === 'gcash') return 'GCash';
  if (method === 'paymaya') return 'PayMaya';
  if (method === 'paypal') return 'PayPal';
  return method ?? '— unset —';
};
