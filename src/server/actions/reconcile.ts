'use server';

/**
 * Reconcile actions for the "Review & Recon Batches" page (/batches) —
 * ported from the legacy ReconcileOverview component (app/index.html ~8724-8817,
 * 9615-9626).
 *
 * "Reconcile" here = finalize confirmed payments to status 'reconciled' and tag
 * the period "Paid · Wise OK". A payment is reconcilable when it is 'sent', has a
 * paid_at, and is either NON-Wise (nothing to match) or Wise WITH a matched
 * transfer id. Genuinely-unmatched Wise rows (sent, wise, no transfer) are left
 * 'sent' and flagged so they can be matched per-period. Status-only, reversible
 * (re-poll), no money moves. Company-scoped; the bulk action requires a single
 * company.
 *
 * NOTE: ideally the two reads/writes below live in src/db/queries (ADR-0002/0003)
 * — that file is outside this cluster's owned set, so they're co-located here and
 * flagged for extraction in the report's crossClusterNeeds.
 */

import { createServerSupabase } from '@/db/clients/server';
import type { Database } from '@/db/types';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';

type PayPeriodState = Database['public']['Enums']['pay_period_state'];

/** One locked/paid period with its rolled-up Wise reconcile counts. */
export interface ReconcileOverviewPeriod {
  id: string;
  start: string;
  end: string;
  state: PayPeriodState;
  /** Total payments in the period. */
  total: number;
  /** Already-reconciled count. */
  reconciled: number;
  /** Confirmed (sent + paid_at) and ready to finalize. */
  readySent: number;
  /** Wise payment, sent, but with no matched transfer id (flagged). */
  unmatchedWise: number;
  /** Not yet paid (draft/queued) — handle in Process & Pay. */
  drafts: number;
}

export interface ReconcileOverview {
  periods: ReconcileOverviewPeriod[];
  /** Sum of readySent across every period. */
  totalReadySent: number;
  /** Count of periods with at least one readySent payment. */
  pendingPeriods: number;
}

/**
 * Build the reconciliation overview: every period that has payments, with its
 * Wise reconcile status. Company-scoped (legacy: company_id filter).
 */
export async function getReconcileOverview(
  companyId: string,
): Promise<ActionResult<ReconcileOverview>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const { data, error } = await db
      .from('payments')
      .select(
        'net_php,status,payout_method,wise_transfer_id,paid_at,pay_periods(id,period_start,period_end,state)',
      )
      .eq('company_id', companyId);
    if (error) return { ok: false, error: error.message };

    const byP = new Map<string, ReconcileOverviewPeriod>();
    for (const p of data ?? []) {
      const pp = p.pay_periods;
      if (!pp) continue;
      const g =
        byP.get(pp.id) ??
        ({
          id: pp.id,
          start: pp.period_start,
          end: pp.period_end,
          state: pp.state,
          total: 0,
          reconciled: 0,
          readySent: 0,
          unmatchedWise: 0,
          drafts: 0,
        } satisfies ReconcileOverviewPeriod);
      g.total += 1;
      if (p.status === 'reconciled') g.reconciled += 1;
      else if (p.status === 'draft' || p.status === 'queued') g.drafts += 1;
      else if (p.status === 'sent') {
        const ready = !!p.paid_at && (p.payout_method !== 'wise' || !!p.wise_transfer_id);
        if (ready) g.readySent += 1;
        else g.unmatchedWise += 1;
      }
      byP.set(pp.id, g);
    }

    const periods = [...byP.values()].sort((a, b) =>
      String(b.start).localeCompare(String(a.start)),
    );
    const totalReadySent = periods.reduce((s, p) => s + p.readySent, 0);
    const pendingPeriods = periods.filter((p) => p.readySent > 0).length;

    return { ok: true, data: { periods, totalReadySent, pendingPeriods } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Bulk "Reconcile all pending": flip every confirmed payment in this company
 * (sent + paid_at + (non-Wise OR Wise with a matched transfer)) to 'reconciled'.
 * Status-only, reversible, no money moves. Mirrors the legacy reconcileAll().
 */
export async function reconcileAllPending(
  companyId: string,
): Promise<ActionResult<{ reconciled: number; periods: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();

    // Count the pending periods for the audit detail (mirrors the JS counter).
    const overview = await getReconcileOverview(companyId);
    const pendingPeriods = overview.ok ? overview.data.pendingPeriods : 0;

    // null payout_method counts as non-Wise (paid, nothing to match) — matches
    // the JS readySent counter.
    const { data: upd, error } = await db
      .from('payments')
      .update({ status: 'reconciled' })
      .eq('company_id', companyId)
      .eq('status', 'sent')
      .not('paid_at', 'is', null)
      .or('payout_method.is.null,payout_method.neq.wise,wise_transfer_id.not.is.null')
      .select('id');
    if (error) return { ok: false, error: error.message };

    const reconciled = (upd ?? []).length;
    await logEvent({
      companyId,
      action: 'wise_recipient_sync',
      entity: 'payments',
      detail: { kind: 'reconcile_all', reconciled, periods: pendingPeriods },
    });

    return { ok: true, data: { reconciled, periods: pendingPeriods } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
