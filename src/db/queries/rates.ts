/**
 * Effective-dated rate persistence (legacy `upsertRate` ~1919 / `saveRate`
 * ~3189). Executes the pure plan from src/lib/pay/rates.ts — the 3-step
 * invariant that prevents duplicate-day rate rows:
 *   1. same-day row exists → UPDATE in place (re-open: effective_end = null);
 *   2. else close open STRICTLY-EARLIER rates (never a future-dated one);
 *   3. insert the new row (period_basis 'semi_monthly').
 */

import 'server-only';
import type { Database } from '@/db/types';
import { planRateUpsert } from '@/lib/pay/rates';
import type { SupabaseClient } from '@supabase/supabase-js';

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
  args: { workerId: string; companyId: string; amountPhp: number; effectiveStart: string },
): Promise<{ kind: 'same-day-update' | 'close-and-insert'; priorAmountPhp: number | null }> => {
  const history = await fetchRateHistory(db, args.workerId, args.companyId);
  const plan = planRateUpsert(history, args.amountPhp, args.effectiveStart);
  const priorAmountPhp = history[0]?.amountPhp ?? null;

  if (plan.kind === 'same-day-update') {
    const { error } = await db
      .from('rates')
      .update({ amount_php: plan.amountPhp, period_basis: 'semi_monthly', effective_end: null })
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
