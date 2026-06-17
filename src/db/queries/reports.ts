/**
 * Reports query module — payroll history reads for the Reports admin screen.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';

type Db = SupabaseClient<Database>;

export type ReportPeriodRow = {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string | null;
  state: Database['public']['Enums']['pay_period_state'];
  /** Sum of gross_php in centavos. */
  totalGrossCentavos: number;
  /** Sum of health_allowance_php in centavos. */
  totalHaCentavos: number;
  /** Sum of thirteenth_month_php in centavos. */
  totalT13Centavos: number;
  /** Sum of net_php in centavos. */
  totalNetCentavos: number;
  contractorCount: number;
};

export type ReportContractorRow = {
  workerId: string;
  workerName: string;
  /** YTD gross in centavos. */
  ytdGrossCentavos: number;
  /** YTD HA in centavos. */
  ytdHaCentavos: number;
  /** YTD 13th month in centavos. */
  ytdT13Centavos: number;
  /** YTD net in centavos. */
  ytdNetCentavos: number;
  periodCount: number;
};

export type ReportPaymentRow = {
  paymentId: string;
  workerId: string;
  workerName: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  grossCentavos: number;
  haCentavos: number;
  t13Centavos: number;
  pddCentavos: number;
  bonusCentavos: number;
  /** Informational performance shortfall (rate − gross); NOT subtracted from net. */
  shortfallCentavos: number;
  netCentavos: number;
  payoutMethod: string | null;
  status: Database['public']['Enums']['payment_status'];
};

/** Pay periods with summary totals in a date range (newest first). */
export const fetchReportPeriods = async (
  db: Db,
  companyId: string,
  fromDate: string,
  toDate: string,
): Promise<ReportPeriodRow[]> => {
  const { data: periods, error: pe } = await db
    .from('pay_periods')
    .select('id, period_start, period_end, pay_date, state')
    .eq('company_id', companyId)
    .gte('period_start', fromDate)
    .lte('period_end', toDate)
    .order('period_start', { ascending: false });
  if (pe) throw new Error(`pay_periods: ${pe.message}`);
  if (!periods?.length) return [];

  const periodIds = periods.map((p) => p.id);
  const { data: pays, error: paye } = await db
    .from('payments')
    .select('pay_period_id, gross_php, health_allowance_php, thirteenth_month_php, net_php')
    .in('pay_period_id', periodIds);
  if (paye) throw new Error(`payments: ${paye.message}`);

  type Agg = {
    count: number;
    gross: number;
    ha: number;
    t13: number;
    net: number;
  };
  const byPeriod = new Map<string, Agg>();
  for (const p of pays ?? []) {
    const cur = byPeriod.get(p.pay_period_id) ?? {
      count: 0,
      gross: 0,
      ha: 0,
      t13: 0,
      net: 0,
    };
    cur.count += 1;
    cur.gross += Math.round(Number(p.gross_php ?? 0) * 100);
    cur.ha += Math.round(Number(p.health_allowance_php ?? 0) * 100);
    cur.t13 += Math.round(Number(p.thirteenth_month_php ?? 0) * 100);
    cur.net += Math.round(Number(p.net_php ?? 0) * 100);
    byPeriod.set(p.pay_period_id, cur);
  }

  return periods.map((p) => {
    const agg = byPeriod.get(p.id) ?? {
      count: 0,
      gross: 0,
      ha: 0,
      t13: 0,
      net: 0,
    };
    return {
      periodId: p.id,
      periodStart: p.period_start,
      periodEnd: p.period_end,
      payDate: p.pay_date,
      state: p.state,
      totalGrossCentavos: agg.gross,
      totalHaCentavos: agg.ha,
      totalT13Centavos: agg.t13,
      totalNetCentavos: agg.net,
      contractorCount: agg.count,
    };
  });
};

/** Per-contractor YTD totals for a company in a year. */
export const fetchContractorYtd = async (
  db: Db,
  companyId: string,
  year: number,
): Promise<ReportContractorRow[]> => {
  const fromDate = `${year}-01-01`;
  const toDate = `${year}-12-31`;

  const { data: periods, error: pe } = await db
    .from('pay_periods')
    .select('id')
    .eq('company_id', companyId)
    .gte('period_start', fromDate)
    .lte('period_end', toDate);
  if (pe) throw new Error(`pay_periods ytd: ${pe.message}`);
  if (!periods?.length) return [];

  const periodIds = periods.map((p) => p.id);
  const { data: pays, error: paye } = await db
    .from('payments')
    .select(
      'worker_id, gross_php, health_allowance_php, thirteenth_month_php, net_php, workers(first_name, middle_name, last_name)',
    )
    .in('pay_period_id', periodIds)
    .eq('company_id', companyId);
  if (paye) throw new Error(`payments ytd: ${paye.message}`);

  type Agg = {
    name: string;
    count: number;
    gross: number;
    ha: number;
    t13: number;
    net: number;
  };
  const byWorker = new Map<string, Agg>();
  for (const p of pays ?? []) {
    const cur = byWorker.get(p.worker_id) ?? {
      name: [p.workers?.first_name, p.workers?.middle_name, p.workers?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim(),
      count: 0,
      gross: 0,
      ha: 0,
      t13: 0,
      net: 0,
    };
    cur.count += 1;
    cur.gross += Math.round(Number(p.gross_php ?? 0) * 100);
    cur.ha += Math.round(Number(p.health_allowance_php ?? 0) * 100);
    cur.t13 += Math.round(Number(p.thirteenth_month_php ?? 0) * 100);
    cur.net += Math.round(Number(p.net_php ?? 0) * 100);
    byWorker.set(p.worker_id, cur);
  }

  return Array.from(byWorker.entries())
    .map(([workerId, agg]) => ({
      workerId,
      workerName: agg.name,
      ytdGrossCentavos: agg.gross,
      ytdHaCentavos: agg.ha,
      ytdT13Centavos: agg.t13,
      ytdNetCentavos: agg.net,
      periodCount: agg.count,
    }))
    .sort((a, b) => a.workerName.localeCompare(b.workerName));
};

/** Detailed payment rows for a date range (for CSV export). */
export const fetchReportPayments = async (
  db: Db,
  companyId: string,
  fromDate: string,
  toDate: string,
): Promise<ReportPaymentRow[]> => {
  const { data: periods, error: pe } = await db
    .from('pay_periods')
    .select('id, period_start, period_end')
    .eq('company_id', companyId)
    .gte('period_start', fromDate)
    .lte('period_end', toDate);
  if (pe) throw new Error(`pay_periods: ${pe.message}`);
  if (!periods?.length) return [];

  const periodMap = new Map(periods.map((p) => [p.id, p]));
  const periodIds = periods.map((p) => p.id);

  const { data: pays, error: paye } = await db
    .from('payments')
    .select(
      'id, worker_id, pay_period_id, gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php, bonus_php, shortfall_php, net_php, payout_method, status, workers(first_name, middle_name, last_name)',
    )
    .in('pay_period_id', periodIds)
    .eq('company_id', companyId)
    .order('pay_period_id')
    .order('worker_id');
  if (paye) throw new Error(`payments detail: ${paye.message}`);

  return (pays ?? []).map((p) => {
    const period = periodMap.get(p.pay_period_id);
    return {
      paymentId: p.id,
      workerId: p.worker_id,
      workerName: [p.workers?.first_name, p.workers?.middle_name, p.workers?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim(),
      periodId: p.pay_period_id,
      periodStart: period?.period_start ?? '',
      periodEnd: period?.period_end ?? '',
      grossCentavos: Math.round(Number(p.gross_php ?? 0) * 100),
      haCentavos: Math.round(Number(p.health_allowance_php ?? 0) * 100),
      t13Centavos: Math.round(Number(p.thirteenth_month_php ?? 0) * 100),
      pddCentavos: Math.round(Number(p.pdd_lunch_php ?? 0) * 100),
      bonusCentavos: Math.round(Number(p.bonus_php ?? 0) * 100),
      shortfallCentavos: Math.round(Number(p.shortfall_php ?? 0) * 100),
      netCentavos: Math.round(Number(p.net_php ?? 0) * 100),
      payoutMethod: p.payout_method,
      status: p.status,
    };
  });
};
