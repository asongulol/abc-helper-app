/**
 * Effective-dated rate persistence (legacy `upsertRate` ~1919 / `saveRate`
 * ~3189). Executes the pure plan from src/lib/pay/rates.ts — the 3-step
 * invariant that prevents duplicate-day rate rows:
 *   1. same-day row exists → UPDATE in place (re-open: effective_end = null);
 *   2. else close open STRICTLY-EARLIER rates (never a future-dated one);
 *   3. insert the new row (period_basis 'semi_monthly').
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';
import { planRateUpsert } from '@/lib/pay/rates';

type Db = SupabaseClient<Database>;

export type RateHistoryRow = {
  id: string;
  amountPhp: number;
  effectiveStart: string;
  effectiveEnd: string | null;
};

/** Rate history for one worker in one company, newest first. */
export const fetchRateHistory = async (
  db: Db,
  workerId: string,
  companyId: string,
): Promise<RateHistoryRow[]> => {
  const { data, error } = await db
    .from('rates')
    .select('id, amount_php, effective_start, effective_end')
    .eq('worker_id', workerId)
    .eq('company_id', companyId)
    .order('effective_start', { ascending: false });
  if (error) throw new Error(`rates: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    amountPhp: Number(r.amount_php),
    effectiveStart: r.effective_start,
    effectiveEnd: r.effective_end,
  }));
};

/** Execute an effective-dated rate save. Returns the prior rate (for audit from→to). */
export const executeRateUpsert = async (
  db: Db,
  args: {
    workerId: string;
    companyId: string;
    amountPhp: number;
    effectiveStart: string;
  },
): Promise<{
  kind: 'same-day-update' | 'close-and-insert';
  priorAmountPhp: number | null;
}> => {
  const history = await fetchRateHistory(db, args.workerId, args.companyId);
  const plan = planRateUpsert(history, args.amountPhp, args.effectiveStart);
  const priorAmountPhp = history[0]?.amountPhp ?? null;

  if (plan.kind === 'same-day-update') {
    const { error } = await db
      .from('rates')
      .update({
        amount_php: plan.amountPhp,
        period_basis: 'semi_monthly',
        effective_end: null,
      })
      .eq('id', plan.rateId);
    if (error) throw new Error(`rates update: ${error.message}`);
    return { kind: plan.kind, priorAmountPhp };
  }

  const { error: closeError } = await db
    .from('rates')
    .update({ effective_end: plan.closeBefore })
    .eq('worker_id', args.workerId)
    .eq('company_id', args.companyId)
    .is('effective_end', null)
    .lt('effective_start', plan.effectiveStart);
  if (closeError) throw new Error(`rates close: ${closeError.message}`);

  const { error: insertError } = await db.from('rates').insert({
    worker_id: args.workerId,
    company_id: args.companyId,
    amount_php: plan.amountPhp,
    period_basis: 'semi_monthly',
    effective_start: plan.effectiveStart,
  });
  if (insertError) throw new Error(`rates insert: ${insertError.message}`);
  return { kind: plan.kind, priorAmountPhp };
};

/**
 * Re-close every effective_end so the timeline stays contiguous: each row's
 * effective_end becomes the NEXT row's effective_start (the newest row stays
 * open / null). Only rows whose stored end actually changed are written.
 * Legacy parity: `saveRateEffectiveEdit` / `deleteRateRow` share this walk.
 */
const recomputeEffectiveEnds = async (
  db: Db,
  workerId: string,
  companyId: string,
): Promise<void> => {
  const { data, error } = await db
    .from('rates')
    .select('id, effective_start, effective_end')
    .eq('worker_id', workerId)
    .eq('company_id', companyId)
    .order('effective_start', { ascending: true });
  if (error) throw new Error(`rates recompute fetch: ${error.message}`);
  const sorted = data ?? [];
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    if (!row) continue;
    const next = sorted[i + 1];
    const desiredEnd = next ? next.effective_start : null;
    if (row.effective_end !== desiredEnd) {
      const { error: upErr } = await db
        .from('rates')
        .update({ effective_end: desiredEnd })
        .eq('id', row.id);
      if (upErr) throw new Error(`rates recompute update: ${upErr.message}`);
    }
  }
};

/**
 * Move one rate row's effective-from date, then re-close the timeline
 * (legacy `saveRateEffectiveEdit`). Returns the prior start for the audit log.
 */
export const editRateEffectiveStart = async (
  db: Db,
  args: { workerId: string; companyId: string; rateId: string; effectiveStart: string },
): Promise<{ from: string }> => {
  const { data: prior, error: readErr } = await db
    .from('rates')
    .select('effective_start')
    .eq('id', args.rateId)
    .eq('worker_id', args.workerId)
    .eq('company_id', args.companyId)
    .maybeSingle();
  if (readErr) throw new Error(`rates read: ${readErr.message}`);
  if (!prior) throw new Error('Rate row not found.');

  const { error } = await db
    .from('rates')
    .update({ effective_start: args.effectiveStart })
    .eq('id', args.rateId)
    .eq('worker_id', args.workerId)
    .eq('company_id', args.companyId);
  if (error) throw new Error(`rates edit: ${error.message}`);

  await recomputeEffectiveEnds(db, args.workerId, args.companyId);
  return { from: prior.effective_start };
};

/**
 * Delete one rate row, then re-close the timeline over the gap
 * (legacy `deleteRateRow`). Returns the deleted row's amount + start for audit.
 */
export const deleteRateRow = async (
  db: Db,
  args: { workerId: string; companyId: string; rateId: string },
): Promise<{ amountPhp: number; effectiveStart: string }> => {
  const { data: prior, error: readErr } = await db
    .from('rates')
    .select('amount_php, effective_start')
    .eq('id', args.rateId)
    .eq('worker_id', args.workerId)
    .eq('company_id', args.companyId)
    .maybeSingle();
  if (readErr) throw new Error(`rates read: ${readErr.message}`);
  if (!prior) throw new Error('Rate row not found.');

  const { error } = await db
    .from('rates')
    .delete()
    .eq('id', args.rateId)
    .eq('worker_id', args.workerId)
    .eq('company_id', args.companyId);
  if (error) throw new Error(`rates delete: ${error.message}`);

  await recomputeEffectiveEnds(db, args.workerId, args.companyId);
  return { amountPhp: Number(prior.amount_php), effectiveStart: prior.effective_start };
};
