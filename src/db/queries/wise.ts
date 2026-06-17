/**
 * Wise payout DB reads and writes.
 *
 * All callers pass an already-created SupabaseClient (ADR-0002/0003 — no
 * inline queries in actions/routes). The service layer (src/server/wise/service.ts)
 * always passes the SERVICE client here — AFTER the role check in the action
 * layer — because these writes bypass RLS (wise_transfer_id, wise_locked_at,
 * wise_dates, status are not writable by the user client's RLS policy).
 * The service client is intentionally not created inside this module so that
 * the query functions remain testable with a mock client.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/db/types';
import type { WiseDates } from '@/lib/wise/types';

type Db = SupabaseClient<Database>;

// ─── types ─────────────────────────────────────────────────────────────────────

export interface PollPayment {
  id: string;
  worker_id: string;
  pay_period_id: string;
  wise_transfer_id: string;
  status: Database['public']['Enums']['payment_status'];
  net_php: number | null;
}

export interface MatchPayment {
  id: string;
  worker_id: string;
  pay_period_id: string;
  wise_transfer_id: string | null;
  status: Database['public']['Enums']['payment_status'];
  net_php: number | null;
  original_net_php: number | null;
  payout_method: Database['public']['Enums']['payout_method'] | null;
  workers: {
    wise_recipient_id: number | null;
    wise_recipient_uuid: string | null;
    wise_recipients: Json | null;
  } | null;
  pay_periods: {
    pay_date: string | null;
    period_start: string;
    period_end: string;
    state: Database['public']['Enums']['pay_period_state'];
  } | null;
}

export interface DraftPayment {
  id: string;
  worker_id: string;
  net_php: number | null;
  wise_transfer_id: string | null;
  workers: {
    wise_recipient_id: number | null;
    wise_recipient_uuid: string | null;
    first_name: string;
    last_name: string;
  } | null;
}

// ─── poll queries ──────────────────────────────────────────────────────────────

/**
 * Fetch payments that have a wise_transfer_id (already drafted in Wise) and
 * are eligible to be reconciled. Used by the `poll` action.
 *
 * @param onlyDrafts  When true (default), restricts to status='draft' — fast
 *                    and idempotent. Pass false to re-check 'sent' rows too.
 * @param payPeriodId Optional scope to a single period.
 */
export const fetchPollPayments = async (
  db: Db,
  opts: { onlyDrafts: boolean; payPeriodId?: string },
): Promise<PollPayment[]> => {
  let q = db
    .from('payments')
    .select('id, worker_id, pay_period_id, wise_transfer_id, status, net_php')
    .not('wise_transfer_id', 'is', null);

  if (opts.onlyDrafts) q = q.eq('status', 'draft');
  if (opts.payPeriodId) q = q.eq('pay_period_id', opts.payPeriodId);

  const { data, error } = await q;
  if (error) throw new Error(`payments (poll): ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    worker_id: row.worker_id,
    pay_period_id: row.pay_period_id,
    wise_transfer_id: row.wise_transfer_id as string,
    status: row.status,
    net_php: row.net_php,
  }));
};

/**
 * Mark a payment as 'sent' with the real sent date from Wise plus the
 * wise_dates triple and an auto-lock. Idempotent — safe to call multiple times.
 */
export const markPaymentSent = async (
  db: Db,
  paymentId: string,
  paidAt: string,
  wiseDates: WiseDates,
  nowIso: string,
): Promise<void> => {
  const { error } = await db
    .from('payments')
    .update({
      status: 'sent',
      paid_at: paidAt,
      wise_dates: wiseDates as unknown as Json,
      wise_locked_at: nowIso,
    })
    .eq('id', paymentId);
  if (error) throw new Error(`markPaymentSent(${paymentId}): ${error.message}`);
};

// ─── match queries ─────────────────────────────────────────────────────────────

/**
 * Fetch payments for the backfill matcher.
 *
 * Default (refresh=false): rows with no wise_transfer_id (unmatched).
 * refresh=true: rows that are already matched, to re-fetch wise_dates / any
 * field that didn't exist when the original match ran.
 */
export const fetchMatchPayments = async (
  db: Db,
  opts: { refresh: boolean; payPeriodId?: string },
): Promise<MatchPayment[]> => {
  let q = db
    .from('payments')
    .select(
      'id,worker_id,pay_period_id,wise_transfer_id,status,net_php,original_net_php,payout_method,workers(wise_recipient_id,wise_recipient_uuid,wise_recipients),pay_periods(pay_date,period_start,period_end,state)',
    )
    .eq('payout_method', 'wise');

  if (opts.refresh) {
    q = q.not('wise_transfer_id', 'is', null);
  } else {
    q = q.is('wise_transfer_id', null);
  }

  if (opts.payPeriodId) q = q.eq('pay_period_id', opts.payPeriodId);

  const { data, error } = await q;
  if (error) throw new Error(`payments (match): ${error.message}`);

  return (data ?? []).map((row) => {
    const w = row.workers;
    const pp = row.pay_periods;
    return {
      id: row.id,
      worker_id: row.worker_id,
      pay_period_id: row.pay_period_id,
      wise_transfer_id: row.wise_transfer_id,
      status: row.status,
      net_php: row.net_php,
      original_net_php: row.original_net_php,
      payout_method: row.payout_method,
      workers: w
        ? {
            wise_recipient_id: w.wise_recipient_id ?? null,
            wise_recipient_uuid: w.wise_recipient_uuid ?? null,
            wise_recipients: w.wise_recipients ?? null,
          }
        : null,
      pay_periods: pp
        ? {
            pay_date: pp.pay_date ?? null,
            period_start: pp.period_start,
            period_end: pp.period_end,
            state: pp.state,
          }
        : null,
    };
  });
};

/**
 * Apply the matcher's proposed patch to a payment row.
 * The patch shape is defined in src/lib/wise/types.ts (PaymentPatch).
 */
export const applyMatchPatch = async (
  db: Db,
  paymentId: string,
  patch: {
    wise_transfer_id?: string;
    wise_dates?: WiseDates;
    original_net_php?: number;
    net_php?: number;
    paid_at?: string;
    status?: string;
    wise_locked_at?: string;
  },
): Promise<void> => {
  // Build the update object using conditional spreads (exactOptionalPropertyTypes).
  const update: Database['public']['Tables']['payments']['Update'] = {};
  if ('wise_transfer_id' in patch && patch.wise_transfer_id !== undefined) {
    update.wise_transfer_id = patch.wise_transfer_id;
  }
  if ('wise_dates' in patch && patch.wise_dates !== undefined) {
    update.wise_dates = patch.wise_dates as unknown as Json;
  }
  if ('original_net_php' in patch && patch.original_net_php !== undefined) {
    update.original_net_php = patch.original_net_php;
  }
  if ('net_php' in patch && patch.net_php !== undefined) {
    update.net_php = patch.net_php;
  }
  if ('paid_at' in patch && patch.paid_at !== undefined) {
    update.paid_at = patch.paid_at;
  }
  if ('status' in patch && patch.status !== undefined) {
    update.status = patch.status as Database['public']['Enums']['payment_status'];
  }
  if ('wise_locked_at' in patch && patch.wise_locked_at !== undefined) {
    update.wise_locked_at = patch.wise_locked_at;
  }

  const { error } = await db.from('payments').update(update).eq('id', paymentId);
  if (error) throw new Error(`applyMatchPatch(${paymentId}): ${error.message}`);
};

// ─── draft queries ─────────────────────────────────────────────────────────────

/**
 * Fetch the payment rows needed to draft Wise transfers: id, net_php, and the
 * worker's current wise_recipient_id.
 */
export const fetchDraftPayments = async (db: Db, paymentIds: string[]): Promise<DraftPayment[]> => {
  if (paymentIds.length === 0) return [];
  const { data, error } = await db
    .from('payments')
    .select(
      'id, worker_id, net_php, wise_transfer_id, workers(wise_recipient_id, wise_recipient_uuid, first_name, last_name)',
    )
    .in('id', paymentIds);
  if (error) throw new Error(`payments (draft): ${error.message}`);

  return (data ?? []).map((row) => {
    const w = row.workers;
    return {
      id: row.id,
      worker_id: row.worker_id,
      net_php: row.net_php,
      wise_transfer_id: row.wise_transfer_id,
      workers: w
        ? {
            wise_recipient_id: w.wise_recipient_id ?? null,
            wise_recipient_uuid: w.wise_recipient_uuid ?? null,
            first_name: w.first_name,
            last_name: w.last_name,
          }
        : null,
    };
  });
};

/** Write the Wise transfer id (and optionally fx_rate) back to a payment row. */
export const setWiseTransferId = async (
  db: Db,
  paymentId: string,
  transferId: string,
  fxRate?: number,
): Promise<void> => {
  const update: Database['public']['Tables']['payments']['Update'] = {
    wise_transfer_id: transferId,
  };
  if (fxRate !== undefined) update.fx_rate = fxRate;
  const { error } = await db.from('payments').update(update).eq('id', paymentId);
  if (error) throw new Error(`setWiseTransferId(${paymentId}): ${error.message}`);
};
