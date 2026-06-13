/**
 * Payroll query module — ALL payroll DB reads/writes live here (no inline
 * queries in actions/routes; ADR-0002/0003). Callers pass an already-created
 * Supabase client: the RLS user client for admin flows, the service client
 * only behind an explicit role check (ADR-0004).
 */

import 'server-only';
import type { Database, Json } from '@/db/types';
import type { MiscItem } from '@/lib/pay/calc';
import type { RateRow } from '@/lib/pay/rates';
import type { PaymentDraft, RosterRow, TimeEntryRow } from '@/lib/payroll/mappers';
import type { SupabaseClient } from '@supabase/supabase-js';

type Db = SupabaseClient<Database>;

/** Approved time entries in [start, end] (tracked + paid PTO; legacy step 1). */
export const fetchApprovedTime = async (
  db: Db,
  companyId: string,
  start: string,
  end: string,
): Promise<TimeEntryRow[]> => {
  const { data, error } = await db
    .from('time_entries')
    .select('worker_id, source_name, work_date, tracked_seconds, pto_seconds, approval')
    .eq('company_id', companyId)
    .gte('work_date', start)
    .lte('work_date', end)
    .eq('approval', 'approved');
  if (error) throw new Error(`time_entries: ${error.message}`);
  return (data ?? []).map((t) => ({
    workerId: t.worker_id,
    sourceName: t.source_name,
    workDate: t.work_date,
    trackedSeconds: Number(t.tracked_seconds ?? 0),
    ptoSeconds: Number(t.pto_seconds ?? 0),
  }));
};

/** Company roster: links + worker payroll fields (legacy step 2). */
export const fetchRoster = async (db: Db, companyId: string): Promise<RosterRow[]> => {
  const { data, error } = await db
    .from('worker_companies')
    .select(
      'worker_id, contract, hubstaff_name, status, workers(first_name, middle_name, last_name, hire_date, status, payout_method, health_allowance_eligible, thirteenth_month_eligible)',
    )
    .eq('company_id', companyId);
  if (error) throw new Error(`worker_companies: ${error.message}`);
  return (data ?? []).map((l) => {
    const w = l.workers;
    return {
      workerId: l.worker_id,
      contract: l.contract,
      hubstaffName: l.hubstaff_name,
      linkStatus: l.status,
      worker: {
        firstName: w?.first_name ?? null,
        middleName: w?.middle_name ?? null,
        lastName: w?.last_name ?? null,
        hireDate: w?.hire_date ?? null,
        status: w?.status ?? null,
        payoutMethod: w?.payout_method ?? null,
        healthAllowanceEligible: w?.health_allowance_eligible ?? false,
        thirteenthMonthEligible: w?.thirteenth_month_eligible ?? false,
      },
    };
  });
};

/** Effective-dated rates for the company (PHP major units, as stored). */
export const fetchRates = async (db: Db, companyId: string): Promise<RateRow[]> => {
  const { data, error } = await db
    .from('rates')
    .select('worker_id, amount_php, effective_start, effective_end')
    .eq('company_id', companyId);
  if (error) throw new Error(`rates: ${error.message}`);
  return (data ?? []).map((r) => ({
    workerId: r.worker_id,
    amountPhp: r.amount_php,
    effectiveStart: r.effective_start,
    effectiveEnd: r.effective_end,
  }));
};

/** Most recent prior payout method per worker (legacy step 3 fallback). */
export const fetchLastPayoutMethods = async (
  db: Db,
  companyId: string,
): Promise<Map<string, string>> => {
  const { data, error } = await db
    .from('payments')
    .select('worker_id, payout_method, created_at')
    .eq('company_id', companyId)
    .not('payout_method', 'is', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`payments: ${error.message}`);
  const out = new Map<string, string>();
  for (const p of data ?? []) {
    if (p.payout_method && !out.has(p.worker_id)) out.set(p.worker_id, p.payout_method);
  }
  return out;
};

export type PeriodRef = { id: string; state: Database['public']['Enums']['pay_period_state'] };

/** Legacy `resolvePeriod`: look up the pay period by company + dates. */
export const findPeriod = async (
  db: Db,
  companyId: string,
  start: string,
  end: string,
): Promise<PeriodRef | null> => {
  const { data, error } = await db
    .from('pay_periods')
    .select('id, state')
    .eq('company_id', companyId)
    .eq('period_start', start)
    .eq('period_end', end)
    .maybeSingle();
  if (error) throw new Error(`pay_periods: ${error.message}`);
  return data ? { id: data.id, state: data.state } : null;
};

/** Upsert the period as OPEN (legacy `saveDraft` step). Returns the row. */
export const upsertOpenPeriod = async (
  db: Db,
  companyId: string,
  start: string,
  end: string,
  payDate: string,
): Promise<PeriodRef> => {
  const { data, error } = await db
    .from('pay_periods')
    .upsert(
      {
        company_id: companyId,
        period_start: start,
        period_end: end,
        pay_date: payDate,
        state: 'open',
      },
      { onConflict: 'company_id,period_start,period_end' },
    )
    .select('id, state')
    .single();
  if (error) throw new Error(`pay_periods upsert: ${error.message}`);
  return { id: data.id, state: data.state };
};

/**
 * Upsert draft payment rows for an OPEN period (conflict on
 * pay_period_id,worker_id). Never call for locked/paid periods — the service
 * layer enforces that (legacy: "don't clobber a locked/paid period").
 */
export const upsertDraftPayments = async (
  db: Db,
  companyId: string,
  payPeriodId: string,
  drafts: readonly PaymentDraft[],
): Promise<void> => {
  if (drafts.length === 0) return;
  const rows = drafts.map((d) => ({
    company_id: companyId,
    pay_period_id: payPeriodId,
    ...d,
    misc_items: d.misc_items as unknown as Json,
    // Validated upstream by PayoutMethodSchema / sourced from the typed roster.
    payout_method: d.payout_method as Database['public']['Enums']['payout_method'] | null,
  }));
  const { error } = await db
    .from('payments')
    .upsert(rows, { onConflict: 'pay_period_id,worker_id' });
  if (error) throw new Error(`payments upsert: ${error.message}`);
};

export type SavedPayment = {
  workerId: string;
  name: string;
  expectedHours: number;
  workedHours: number;
  ratio: number;
  ratePhp: number | null;
  grossPhp: number | null;
  haPhp: number;
  t13Php: number;
  pddPhp: number;
  bonusPhp: number;
  dedPhp: number;
  netPhp: number | null;
  miscItems: MiscItem[];
  payoutMethod: string | null;
  overridden: boolean;
};

/** Saved draft/locked snapshot rows for a period (legacy `loadSaved`). */
export const fetchSavedPayments = async (db: Db, payPeriodId: string): Promise<SavedPayment[]> => {
  const { data, error } = await db
    .from('payments')
    .select(
      'worker_id, expected_hours, worked_hours, performance_ratio, rate_php, gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php, bonus_php, deduction_php, net_php, misc_items, payout_method, note, workers(first_name, middle_name, last_name)',
    )
    .eq('pay_period_id', payPeriodId);
  if (error) throw new Error(`payments: ${error.message}`);
  return (data ?? []).map((p) => ({
    workerId: p.worker_id,
    name: [p.workers?.first_name, p.workers?.middle_name, p.workers?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim(),
    expectedHours: Number(p.expected_hours ?? 0),
    workedHours: Number(p.worked_hours ?? 0),
    ratio: Number(p.performance_ratio ?? 0),
    ratePhp: p.rate_php,
    grossPhp: p.gross_php,
    haPhp: Number(p.health_allowance_php ?? 0),
    t13Php: Number(p.thirteenth_month_php ?? 0),
    pddPhp: Number(p.pdd_lunch_php ?? 0),
    bonusPhp: Number(p.bonus_php ?? 0),
    dedPhp: Number(p.deduction_php ?? 0),
    netPhp: p.net_php,
    miscItems: Array.isArray(p.misc_items) ? (p.misc_items as MiscItem[]) : [],
    payoutMethod: p.payout_method,
    overridden: !!p.note,
  }));
};
