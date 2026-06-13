/**
 * Status pill tone mapping for pay_period_state and payment_status.
 * Pure: no DB, no React.
 */

import type { BadgeTone } from '@/components/ui/Badge';

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

export const paymentStatusTone = (
  status: 'draft' | 'queued' | 'sent' | 'failed' | 'reconciled',
): BadgeTone => {
  if (status === 'sent' || status === 'reconciled') return 'good';
  if (status === 'failed') return 'bad';
  if (status === 'queued') return 'warn';
  return 'neutral';
};

export const paymentStatusLabel = (
  status: 'draft' | 'queued' | 'sent' | 'failed' | 'reconciled',
): string => {
  if (status === 'sent') return 'paid';
  if (status === 'reconciled') return 'reconciled';
  if (status === 'queued') return 'queued';
  if (status === 'failed') return 'failed';
  return 'unpaid';
};

export const payoutMethodLabel = (method: string | null): string => {
  if (method === 'wise') return 'Wise';
  if (method === 'bpi') return 'BPI';
  if (method === 'gcash') return 'GCash';
  if (method === 'paymaya') return 'PayMaya';
  if (method === 'paypal') return 'PayPal';
  return method ?? '— unset —';
};
