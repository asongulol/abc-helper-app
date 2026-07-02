/**
 * Overview query module — all DB reads for the /overview page.
 * Callers pass an already-created SupabaseClient (RLS user client).
 * All money is in PHP major units as stored; callers convert to centavos
 * for integer arithmetic before display.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';

type Db = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------

/** Count of active workers linked to a company. */
export const countActiveContractors = async (db: Db, companyId: string): Promise<number> => {
  const { count, error } = await db
    .from('worker_companies')
    .select('worker_id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'active');
  if (error) throw new Error(`countActiveContractors: ${error.message}`);
  return count ?? 0;
};

/** Sum of net_php for a specific pay period (PHP major units). */
export const getPeriodNetTotal = async (
  db: Db,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<number | null> => {
  // Get the period ID first
  const { data: periodData, error: periodError } = await db
    .from('pay_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .maybeSingle();
  if (periodError) throw new Error(`getPeriodNetTotal period: ${periodError.message}`);
  if (!periodData) return null;

  const { data, error } = await db
    .from('payments')
    .select('net_php')
    .eq('pay_period_id', periodData.id)
    .eq('company_id', companyId);
  if (error) throw new Error(`getPeriodNetTotal payments: ${error.message}`);
  if (!data || data.length === 0) return null;

  // Integer centavos accumulation
  let sumCentavos = 0;
  for (const row of data) {
    sumCentavos += Math.round(row.net_php * 100);
  }
  return sumCentavos / 100;
};

/** Count of pending time entries (approval = 'pending') for a company. */
export const countPendingTimeApprovals = async (db: Db, companyId: string): Promise<number> => {
  const { count, error } = await db
    .from('time_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('approval', 'pending');
  if (error) throw new Error(`countPendingTimeApprovals: ${error.message}`);
  return count ?? 0;
};

/**
 * Count of payments stuck in a failed payout state (any period) for a company.
 * Backs the Overview "Payout issues" tile — a failed Wise transfer needs
 * attention regardless of which period it belongs to.
 */
export const countFailedPayouts = async (db: Db, companyId: string): Promise<number> => {
  const { count, error } = await db
    .from('payments')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'failed');
  if (error) throw new Error(`countFailedPayouts: ${error.message}`);
  return count ?? 0;
};

// ---------------------------------------------------------------------------
// Pay-cycle pipeline
// ---------------------------------------------------------------------------

export interface PipelineStageData {
  /** true when this stage has time entries with the given approval state, or payments
   *  at the given status, or a period at the given state. */
  done: boolean;
  /** Brief sub-label, e.g. count of records. */
  detail: string | null;
}

export interface PipelineData {
  timeImported: PipelineStageData;
  approved: PipelineStageData;
  calculated: PipelineStageData;
  locked: PipelineStageData;
  paid: PipelineStageData;
  /** Period state from pay_periods row, null if no period found. */
  periodState: Database['public']['Enums']['pay_period_state'] | null;
}

/** Pay-cycle pipeline state for the current semi-monthly period. */
export const getPipelineData = async (
  db: Db,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<PipelineData> => {
  // Counts only — let Postgres count (head:true transfers zero rows), and run
  // the independent queries in parallel instead of three sequential fetches.
  const [totalRes, approvedRes, periodRes] = await Promise.all([
    db
      .from('time_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gte('work_date', periodStart)
      .lte('work_date', periodEnd),
    db
      .from('time_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gte('work_date', periodStart)
      .lte('work_date', periodEnd)
      .eq('approval', 'approved'),
    db
      .from('pay_periods')
      .select('id, state')
      .eq('company_id', companyId)
      .eq('period_start', periodStart)
      .eq('period_end', periodEnd)
      .maybeSingle(),
  ]);
  if (totalRes.error) throw new Error(`getPipelineData entries: ${totalRes.error.message}`);
  if (approvedRes.error) throw new Error(`getPipelineData entries: ${approvedRes.error.message}`);
  if (periodRes.error) throw new Error(`getPipelineData period: ${periodRes.error.message}`);

  const totalEntries = totalRes.count ?? 0;
  const approvedEntries = approvedRes.count ?? 0;
  const period = periodRes.data;

  let paymentCount = 0;
  let paidCount = 0;
  if (period) {
    const [payTotalRes, payPaidRes] = await Promise.all([
      db
        .from('payments')
        .select('id', { count: 'exact', head: true })
        .eq('pay_period_id', period.id),
      db
        .from('payments')
        .select('id', { count: 'exact', head: true })
        .eq('pay_period_id', period.id)
        .in('status', ['sent', 'reconciled']),
    ]);
    if (payTotalRes.error)
      throw new Error(`getPipelineData payments: ${payTotalRes.error.message}`);
    if (payPaidRes.error) throw new Error(`getPipelineData payments: ${payPaidRes.error.message}`);
    paymentCount = payTotalRes.count ?? 0;
    paidCount = payPaidRes.count ?? 0;
  }

  const periodState = period?.state ?? null;
  const isLocked = periodState === 'locked' || periodState === 'paid';
  const isPaid = periodState === 'paid';

  return {
    timeImported: {
      done: totalEntries > 0,
      detail: totalEntries > 0 ? `${totalEntries} entr${totalEntries === 1 ? 'y' : 'ies'}` : null,
    },
    approved: {
      done: approvedEntries > 0,
      detail: approvedEntries > 0 ? `${approvedEntries} approved` : null,
    },
    calculated: {
      done: paymentCount > 0,
      detail: paymentCount > 0 ? `${paymentCount} payment${paymentCount === 1 ? '' : 's'}` : null,
    },
    locked: {
      done: isLocked,
      detail: isLocked ? periodState : null,
    },
    paid: {
      done: isPaid || paidCount > 0,
      detail: paidCount > 0 ? `${paidCount} sent` : isPaid ? 'paid' : null,
    },
    periodState,
  };
};

// ---------------------------------------------------------------------------
// Sparkline: recent periods net total
// ---------------------------------------------------------------------------

export interface RecentPeriodNet {
  periodStart: string;
  periodEnd: string;
  totalNetPhp: number;
}

/**
 * Net totals for the most recent `limit` locked/paid periods (newest first).
 * Used to build the sparkline.
 */
export const getRecentPeriodNets = async (
  db: Db,
  companyId: string,
  limit = 8,
): Promise<RecentPeriodNet[]> => {
  // Postgres aggregates per period (pay_period_summaries view, migration 0027)
  // — one round-trip returning `limit` rows instead of every payment row.
  const { data, error } = await db
    .from('pay_period_summaries')
    .select('period_start, period_end, total_net_php')
    .eq('company_id', companyId)
    .in('state', ['locked', 'paid'])
    .order('period_start', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`getRecentPeriodNets periods: ${error.message}`);

  // Build result ordered oldest → newest for the sparkline
  return (data ?? []).reverse().flatMap((p) =>
    p.period_start && p.period_end
      ? [
          {
            periodStart: p.period_start,
            periodEnd: p.period_end,
            totalNetPhp: Number(p.total_net_php ?? 0),
          },
        ]
      : [],
  );
};

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export interface AlertItem {
  kind: 'no_rate' | 'no_payout_method';
  workerId: string;
  workerName: string;
}

/**
 * Workers with approved time in the current period but no effective rate, and
 * workers with payments missing a payout method.
 */
export const getAlerts = async (
  db: Db,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<AlertItem[]> => {
  const alerts: AlertItem[] = [];

  // Workers with approved time entries in this period
  const { data: approvedEntries, error: entryError } = await db
    .from('time_entries')
    .select('worker_id')
    .eq('company_id', companyId)
    .eq('approval', 'approved')
    .gte('work_date', periodStart)
    .lte('work_date', periodEnd)
    .not('worker_id', 'is', null);
  if (entryError) throw new Error(`getAlerts entries: ${entryError.message}`);

  const workerIdsWithTime = [
    ...new Set((approvedEntries ?? []).map((e) => e.worker_id).filter((id): id is string => !!id)),
  ];

  if (workerIdsWithTime.length > 0) {
    // Find their rates for this period
    const { data: rates, error: rateError } = await db
      .from('rates')
      .select('worker_id')
      .eq('company_id', companyId)
      .lte('effective_start', periodEnd)
      .or(`effective_end.is.null,effective_end.gte.${periodStart}`);
    if (rateError) throw new Error(`getAlerts rates: ${rateError.message}`);

    const workerIdsWithRate = new Set((rates ?? []).map((r) => r.worker_id));
    const noRateIds = workerIdsWithTime.filter((id) => !workerIdsWithRate.has(id));

    if (noRateIds.length > 0) {
      const { data: workers, error: workerError } = await db
        .from('workers')
        .select('id, first_name, last_name')
        .in('id', noRateIds);
      if (workerError) throw new Error(`getAlerts workers (no_rate): ${workerError.message}`);
      for (const w of workers ?? []) {
        alerts.push({
          kind: 'no_rate',
          workerId: w.id,
          workerName: [w.first_name, w.last_name].filter(Boolean).join(' ') || w.id,
        });
      }
    }
  }

  // Payments missing payout method
  const { data: periodRow, error: periodError } = await db
    .from('pay_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .maybeSingle();
  if (periodError) throw new Error(`getAlerts period: ${periodError.message}`);

  if (periodRow) {
    const { data: noMethodPayments, error: pmError } = await db
      .from('payments')
      .select('worker_id, workers(first_name, last_name)')
      .eq('pay_period_id', periodRow.id)
      .is('payout_method', null);
    if (pmError) throw new Error(`getAlerts payments no_method: ${pmError.message}`);
    for (const p of noMethodPayments ?? []) {
      const w = p.workers;
      alerts.push({
        kind: 'no_payout_method',
        workerId: p.worker_id,
        workerName: w
          ? [w.first_name, w.last_name].filter(Boolean).join(' ') || p.worker_id
          : p.worker_id,
      });
    }
  }

  return alerts;
};
