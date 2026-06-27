/**
 * Payroll query module — ALL payroll DB reads/writes live here (no inline
 * queries in actions/routes; ADR-0002/0003). Callers pass an already-created
 * Supabase client: the RLS user client for admin flows, the service client
 * only behind an explicit role check (ADR-0004).
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cache } from 'react';
import type { Database, Json } from '@/db/types';
import { type Centavos, centavos, majorToMinor } from '@/lib/money';
import type { MiscItem } from '@/lib/pay/calc';
import type { RateRow } from '@/lib/pay/rates';
import type { PaymentDraft, RosterRow, TimeEntryRow } from '@/lib/payroll/mappers';

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

/**
 * Count time_entries still awaiting approval (approval='pending') in
 * [start, end] for a company. Used by lockPeriod to refuse locking a period
 * that still has unapproved hours — those hours are invisible to
 * fetchApprovedTime and would be silently underpaid (review finding F2).
 */
export const countPendingTime = async (
  db: Db,
  companyId: string,
  start: string,
  end: string,
): Promise<number> => {
  const { count, error } = await db
    .from('time_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .gte('work_date', start)
    .lte('work_date', end)
    .eq('approval', 'pending');
  if (error) throw new Error(`pending time count: ${error.message}`);
  return count ?? 0;
};

/** Company roster: links + worker payroll fields (legacy step 2). */
export const fetchRoster = async (db: Db, companyId: string): Promise<RosterRow[]> => {
  const { data, error } = await db
    .from('worker_companies')
    .select(
      'worker_id, contract, pay_basis, hubstaff_name, status, workers(first_name, middle_name, last_name, hire_date, status, payout_method, health_allowance_eligible, thirteenth_month_eligible)',
    )
    .eq('company_id', companyId);
  if (error) throw new Error(`worker_companies: ${error.message}`);
  return (data ?? []).map((l) => {
    const w = l.workers;
    return {
      workerId: l.worker_id,
      contract: l.contract,
      payBasis: l.pay_basis ?? null,
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

/**
 * Σ approved session units in [start, end] per worker — for PS (per-session)
 * pay. Sessions are recorded against CLIENT companies, so this is scoped by
 * worker_id + date (not the payroll company) and summed across the worker's
 * clients. Only approved sessions are paid (mirrors billing).
 */
export const fetchSessionUnitsByWorker = async (
  db: Db,
  workerIds: string[],
  from: string,
  to: string,
): Promise<Map<string, number>> => {
  const out = new Map<string, number>();
  if (workerIds.length === 0) return out;
  const { data, error } = await db
    .from('service_sessions')
    .select('worker_id, units')
    .in('worker_id', workerIds)
    .eq('approval', 'approved')
    .is('paid_at', null) // exclude sessions already paid off-cycle (or at a prior lock)
    .gte('session_date', from)
    .lte('session_date', to)
    .limit(100000);
  if (error) throw new Error(`session units: ${error.message}`);
  for (const r of data ?? []) {
    if (!r.worker_id) continue;
    out.set(r.worker_id, (out.get(r.worker_id) ?? 0) + (Number(r.units) || 0));
  }
  return out;
};

/**
 * Approved session units per worker broken down by session_date, for PS
 * date-aware gross (F4). Same scope/approval rules as
 * {@link fetchSessionUnitsByWorker}; the per-worker total is just the sum of a
 * worker's date buckets.
 */
export const fetchSessionUnitsByWorkerByDate = async (
  db: Db,
  workerIds: string[],
  from: string,
  to: string,
): Promise<Map<string, Map<string, number>>> => {
  const out = new Map<string, Map<string, number>>();
  if (workerIds.length === 0) return out;
  const { data, error } = await db
    .from('service_sessions')
    .select('worker_id, session_date, units')
    .in('worker_id', workerIds)
    .eq('approval', 'approved')
    .is('paid_at', null) // exclude sessions already paid off-cycle (or at a prior lock)
    .gte('session_date', from)
    .lte('session_date', to)
    .limit(100000);
  if (error) throw new Error(`session units by date: ${error.message}`);
  for (const r of data ?? []) {
    if (!r.worker_id || !r.session_date) continue;
    const byDate = out.get(r.worker_id) ?? new Map<string, number>();
    byDate.set(r.session_date, (byDate.get(r.session_date) ?? 0) + (Number(r.units) || 0));
    out.set(r.worker_id, byDate);
  }
  return out;
};

/* ---------- Off-cycle pay ledger (per-session / per-hour) ---------- */

export type OffCycleItemRow = {
  id: string;
  workerId: string;
  payPeriodId: string;
  basis: 'per_session' | 'per_hour';
  sessionId: string | null;
  workDate: string | null;
  units: number | null;
  ratePhp: number | null;
  amountPhp: number;
  description: string | null;
  createdAt: string;
};

type RawOffCycleRow = {
  id: string;
  worker_id: string;
  pay_period_id: string;
  basis: string;
  session_id: string | null;
  work_date: string | null;
  units: number | null;
  rate_php: number | null;
  amount_php: number;
  description: string | null;
  created_at: string;
};

const OFF_CYCLE_COLS =
  'id, worker_id, pay_period_id, basis, session_id, work_date, units, rate_php, amount_php, description, created_at';

const mapOffCycleRow = (r: RawOffCycleRow): OffCycleItemRow => ({
  id: r.id,
  workerId: r.worker_id,
  payPeriodId: r.pay_period_id,
  basis: r.basis === 'per_hour' ? 'per_hour' : 'per_session',
  sessionId: r.session_id,
  workDate: r.work_date,
  units: r.units == null ? null : Number(r.units),
  ratePhp: r.rate_php == null ? null : Number(r.rate_php),
  amountPhp: Number(r.amount_php) || 0,
  description: r.description,
  createdAt: r.created_at,
});

/**
 * All off-cycle ledger items for a period, with per-worker centavos totals and
 * the per-hour work-dates per worker (so the engine can drop in-window hours
 * that were already paid off-cycle). Employer-scoped — read with the RLS user
 * client. The engine re-applies these on every calculate so the line survives
 * recalc (misc_items would not — calculateDraft resets them).
 */
export const fetchOffCycleItemsForPeriod = async (
  db: Db,
  companyId: string,
  payPeriodId: string,
  workerIds: string[],
): Promise<{
  byWorkerCentavos: Map<string, Centavos>;
  perHourDatesByWorker: Map<string, Set<string>>;
  rows: OffCycleItemRow[];
}> => {
  const byWorkerCentavos = new Map<string, Centavos>();
  const perHourDatesByWorker = new Map<string, Set<string>>();
  const rows: OffCycleItemRow[] = [];
  if (workerIds.length === 0) return { byWorkerCentavos, perHourDatesByWorker, rows };
  const { data, error } = await db
    .from('off_cycle_pay_items')
    .select(OFF_CYCLE_COLS)
    .eq('company_id', companyId)
    .eq('pay_period_id', payPeriodId)
    .in('worker_id', workerIds);
  if (error) throw new Error(`off-cycle items: ${error.message}`);
  for (const raw of (data ?? []) as RawOffCycleRow[]) {
    const row = mapOffCycleRow(raw);
    rows.push(row);
    const prev = byWorkerCentavos.get(row.workerId) ?? 0;
    byWorkerCentavos.set(row.workerId, centavos(prev + majorToMinor(row.amountPhp)));
    if (row.basis === 'per_hour' && row.workDate) {
      const set = perHourDatesByWorker.get(row.workerId) ?? new Set<string>();
      set.add(row.workDate);
      perHourDatesByWorker.set(row.workerId, set);
    }
  }
  return { byWorkerCentavos, perHourDatesByWorker, rows };
};

/** Off-cycle items for one worker in a period (newest first) — for the UI list. */
export const fetchOffCycleItemsForWorkerPeriod = async (
  db: Db,
  payPeriodId: string,
  workerId: string,
): Promise<OffCycleItemRow[]> => {
  const { data, error } = await db
    .from('off_cycle_pay_items')
    .select(OFF_CYCLE_COLS)
    .eq('pay_period_id', payPeriodId)
    .eq('worker_id', workerId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`off-cycle items (worker): ${error.message}`);
  return ((data ?? []) as RawOffCycleRow[]).map(mapOffCycleRow);
};

/** Σ off-cycle amount for one worker in a period, in centavos. */
export const fetchOffCycleTotalForWorker = async (
  db: Db,
  payPeriodId: string,
  workerId: string,
): Promise<Centavos> => {
  const { data, error } = await db
    .from('off_cycle_pay_items')
    .select('amount_php')
    .eq('pay_period_id', payPeriodId)
    .eq('worker_id', workerId);
  if (error) throw new Error(`off-cycle total: ${error.message}`);
  let total = 0;
  for (const r of data ?? []) total += majorToMinor(Number(r.amount_php) || 0);
  return centavos(total);
};

export type NewOffCycleItem = {
  companyId: string;
  workerId: string;
  payPeriodId: string;
  basis: 'per_session' | 'per_hour';
  sessionId: string | null;
  workDate: string | null;
  units: number | null;
  ratePhp: number | null;
  amountPhp: number;
  description: string | null;
};

/**
 * Insert one or more off-cycle ledger rows (pick-mode creates one row per
 * selected session so each session is uniquely guarded by the session_id unique
 * index). Surfaces the Postgres unique-violation (23505) so the caller can map
 * it to a friendly "already paid / already added" message.
 */
export const insertOffCycleItems = async (
  db: Db,
  rows: readonly NewOffCycleItem[],
): Promise<OffCycleItemRow[]> => {
  if (rows.length === 0) return [];
  const { data, error } = await db
    .from('off_cycle_pay_items')
    .insert(
      rows.map((r) => ({
        company_id: r.companyId,
        worker_id: r.workerId,
        pay_period_id: r.payPeriodId,
        basis: r.basis,
        session_id: r.sessionId,
        work_date: r.workDate,
        units: r.units,
        rate_php: r.ratePhp,
        amount_php: r.amountPhp,
        description: r.description,
      })),
    )
    .select(OFF_CYCLE_COLS);
  if (error) {
    const e = error as { code?: string; message: string };
    if (e.code === '23505') throw new Error('ALREADY_PAID');
    throw new Error(`add off-cycle item: ${e.message}`);
  }
  return ((data ?? []) as RawOffCycleRow[]).map(mapOffCycleRow);
};

/** One off-cycle item (employer-scoped) — used to verify the period before a
 *  remove, and to drive the follow-up recompute + session unmark. */
export const fetchOffCycleItem = async (
  db: Db,
  companyId: string,
  id: string,
): Promise<{ workerId: string; payPeriodId: string; sessionId: string | null } | null> => {
  const { data, error } = await db
    .from('off_cycle_pay_items')
    .select('worker_id, pay_period_id, session_id')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`off-cycle item: ${error.message}`);
  return data
    ? { workerId: data.worker_id, payPeriodId: data.pay_period_id, sessionId: data.session_id }
    : null;
};

/** Delete one off-cycle item (scoped to the employer company) and return the
 *  removed row's worker/period/session for the follow-up recompute + unmark. */
export const deleteOffCycleItem = async (
  db: Db,
  companyId: string,
  id: string,
): Promise<{ workerId: string; payPeriodId: string; sessionId: string | null } | null> => {
  const { data, error } = await db
    .from('off_cycle_pay_items')
    .delete()
    .eq('company_id', companyId)
    .eq('id', id)
    .select('worker_id, pay_period_id, session_id')
    .maybeSingle();
  if (error) throw new Error(`delete off-cycle item: ${error.message}`);
  return data
    ? { workerId: data.worker_id, payPeriodId: data.pay_period_id, sessionId: data.session_id }
    : null;
};

/** Stamp the worker-pay paid marker on sessions (service client — sessions are
 *  CLIENT-company scoped, invisible to the employer admin under RLS). */
export const markSessionsPaid = async (
  db: Db,
  sessionIds: readonly string[],
  payPeriodId: string,
  paymentId: string | null,
  paidAt: string,
): Promise<void> => {
  if (sessionIds.length === 0) return;
  const { error } = await db
    .from('service_sessions')
    .update({ paid_at: paidAt, paid_pay_period_id: payPeriodId, paid_payment_id: paymentId })
    .in('id', sessionIds);
  if (error) throw new Error(`mark sessions paid: ${error.message}`);
};

/** Clear the worker-pay paid marker (off-cycle item removed). */
export const clearSessionsPaid = async (db: Db, sessionIds: readonly string[]): Promise<void> => {
  if (sessionIds.length === 0) return;
  const { error } = await db
    .from('service_sessions')
    .update({ paid_at: null, paid_pay_period_id: null, paid_payment_id: null })
    .in('id', sessionIds);
  if (error) throw new Error(`clear sessions paid: ${error.message}`);
};

/** A payment row's money components for the surgical off-cycle net recompute. */
export type PaymentComponents = {
  paymentId: string;
  grossPhp: number | null;
  haPhp: number;
  t13Php: number;
  pddPhp: number;
  bonusPhp: number;
  miscItems: MiscItem[];
};

export const fetchPaymentForWorker = async (
  db: Db,
  payPeriodId: string,
  workerId: string,
): Promise<PaymentComponents | null> => {
  const { data, error } = await db
    .from('payments')
    .select(
      'id, gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php, bonus_php, misc_items',
    )
    .eq('pay_period_id', payPeriodId)
    .eq('worker_id', workerId)
    .maybeSingle();
  if (error) throw new Error(`payment for worker: ${error.message}`);
  if (!data) return null;
  return {
    paymentId: data.id,
    grossPhp: data.gross_php,
    haPhp: Number(data.health_allowance_php ?? 0),
    t13Php: Number(data.thirteenth_month_php ?? 0),
    pddPhp: Number(data.pdd_lunch_php ?? 0),
    bonusPhp: Number(data.bonus_php ?? 0),
    miscItems: Array.isArray(data.misc_items) ? (data.misc_items as MiscItem[]) : [],
  };
};

/** Surgical update of off_cycle_php + net_php on an existing (open) payment row.
 *  Matches updatePaymentRow semantics: leaves payout_amount untouched (Wise pays
 *  net_php; payout_amount is reference). */
export const setPaymentOffCycle = async (
  db: Db,
  paymentId: string,
  offCyclePhp: number,
  netPhp: number,
): Promise<void> => {
  const { error } = await db
    .from('payments')
    .update({ off_cycle_php: offCyclePhp, net_php: netPhp })
    .eq('id', paymentId);
  if (error) throw new Error(`set off-cycle: ${error.message}`);
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

export type PeriodRef = {
  id: string;
  state: Database['public']['Enums']['pay_period_state'];
};

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

/**
 * Delete draft payment rows for an OPEN period whose worker is NOT in
 * `keepWorkerIds`. Used by the recalc path so that retracting a worker's
 * approved time and recalculating removes their stale payment row instead of
 * leaving it payable (review finding F5). An empty keep-set deletes ALL rows
 * for the period (no payable workers remain). Returns the number deleted.
 *
 * Caller must guarantee the period is open (the only payments trigger that
 * enforces period state guards INSERT/UPDATE, not DELETE).
 */
export const pruneDraftPaymentsExcept = async (
  db: Db,
  payPeriodId: string,
  keepWorkerIds: readonly string[],
): Promise<number> => {
  let q = db.from('payments').delete().eq('pay_period_id', payPeriodId);
  if (keepWorkerIds.length > 0) {
    const list = keepWorkerIds.map((w) => `"${w}"`).join(',');
    q = q.not('worker_id', 'in', `(${list})`);
  }
  const { data, error } = await q.select('id');
  if (error) throw new Error(`prune draft payments: ${error.message}`);
  return (data ?? []).length;
};

/** A full payments row captured for the recalc undo snapshot (F6). */
export type PaymentSnapshotRow = Database['public']['Tables']['payments']['Row'];

/**
 * Snapshot every payments row for a period verbatim (all columns) so a recalc
 * can be undone (F6). Returns [] when the period has no rows yet.
 */
export const fetchPaymentRowsForRestore = async (
  db: Db,
  payPeriodId: string,
): Promise<PaymentSnapshotRow[]> => {
  const { data, error } = await db.from('payments').select('*').eq('pay_period_id', payPeriodId);
  if (error) throw new Error(`payment snapshot: ${error.message}`);
  return data ?? [];
};

/**
 * Restore a previously-captured snapshot: delete the period's current rows and
 * re-insert the snapshot verbatim (F6 undo). company_id/pay_period_id are forced
 * to the verified values so a client can't inject rows into another period.
 * Caller must verify the period is OPEN (the period-state trigger blocks inserts
 * otherwise). Returns the number of rows restored.
 */
export const restorePaymentRows = async (
  db: Db,
  companyId: string,
  payPeriodId: string,
  rows: readonly PaymentSnapshotRow[],
): Promise<number> => {
  const { error: delError } = await db.from('payments').delete().eq('pay_period_id', payPeriodId);
  if (delError) throw new Error(`restore (clear): ${delError.message}`);
  if (rows.length === 0) return 0;
  const sanitized = rows.map((r) => ({
    ...r,
    company_id: companyId,
    pay_period_id: payPeriodId,
  }));
  const { error: insError } = await db.from('payments').insert(sanitized);
  if (insError) throw new Error(`restore (insert): ${insError.message}`);
  return sanitized.length;
};

export type SavedPayment = {
  /** UUID of the payments row — required for updatePaymentRowAction / deleteStatement. */
  paymentId: string;
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
  /** Informational performance shortfall (rate − gross); NOT subtracted from net. */
  shortfallPhp: number;
  /** Off-cycle per-session/per-hour earnings on this row (ledger total). */
  offCyclePhp: number;
  netPhp: number | null;
  miscItems: MiscItem[];
  payoutMethod: string | null;
  overridden: boolean;
};

/* ---------- NEW: list periods with summary totals ---------- */

export type PeriodSummaryRow = {
  id: string;
  state: Database['public']['Enums']['pay_period_state'];
  periodStart: string;
  periodEnd: string;
  payDate: string | null;
  lockedAt: string | null;
  contractorCount: number;
  /** Sum of net_php in integer centavos. */
  totalNetCentavos: number;
};

/**
 * All pay periods for the company, newest first, with contractor count + net.
 *
 * `cache()`-wrapped: the admin layout loads period summaries for the ⌘K palette
 * on every page, and /overview, /payroll, /batches load them again. One cached
 * Supabase client means a single query per request. Keyed on (db, companyId).
 */
export const fetchPeriodSummaries = cache(
  async (db: Db, companyId: string): Promise<PeriodSummaryRow[]> => {
    const { data: periods, error: e1 } = await db
      .from('pay_periods')
      .select('id, state, period_start, period_end, pay_date, locked_at')
      .eq('company_id', companyId)
      .order('period_start', { ascending: false });
    if (e1) throw new Error(`pay_periods: ${e1.message}`);
    if (!periods?.length) return [];

    const periodIds = periods.map((p) => p.id);
    const { data: pays, error: e2 } = await db
      .from('payments')
      .select('pay_period_id, net_php')
      .in('pay_period_id', periodIds);
    if (e2) throw new Error(`payments summary: ${e2.message}`);

    const byPeriod = new Map<string, { count: number; netCentavos: number }>();
    for (const p of pays ?? []) {
      const cur = byPeriod.get(p.pay_period_id) ?? { count: 0, netCentavos: 0 };
      cur.count += 1;
      cur.netCentavos += Math.round(Number(p.net_php ?? 0) * 100);
      byPeriod.set(p.pay_period_id, cur);
    }

    return (periods ?? []).map((p) => {
      const agg = byPeriod.get(p.id) ?? { count: 0, netCentavos: 0 };
      return {
        id: p.id,
        state: p.state,
        periodStart: p.period_start,
        periodEnd: p.period_end,
        payDate: p.pay_date,
        lockedAt: p.locked_at,
        contractorCount: agg.count,
        totalNetCentavos: agg.netCentavos,
      };
    });
  },
);

/* ---------- NEW: lock / unlock period ---------- */

/** Transition period to 'locked'. Caller must verify no null-rate rows first. */
export const lockPeriod = async (db: Db, periodId: string, payDate: string): Promise<void> => {
  const { error } = await db
    .from('pay_periods')
    .update({
      state: 'locked',
      locked_at: new Date().toISOString(),
      pay_date: payDate,
    })
    .eq('id', periodId);
  if (error) throw new Error(`lock period: ${error.message}`);
};

/** Transition period back to 'open'. Refuses 'paid'. */
export const unlockPeriod = async (db: Db, periodId: string): Promise<void> => {
  const { data: existing } = await db
    .from('pay_periods')
    .select('state')
    .eq('id', periodId)
    .maybeSingle();
  if (existing?.state === 'paid') throw new Error('Period is paid — mark all unpaid first.');
  const { error } = await db
    .from('pay_periods')
    .update({ state: 'open', locked_at: null })
    .eq('id', periodId);
  if (error) throw new Error(`unlock period: ${error.message}`);
};

/* ---------- NEW: update a single payment row ---------- */

export type PaymentRowFields = {
  grossPhp?: number | null;
  haPhp?: number;
  t13Php?: number | null;
  pddPhp?: number;
  bonusPhp?: number;
  miscItems?: unknown;
  netPhp?: number;
  payoutMethod?: string | null;
  fxRate?: number;
  note?: string | null;
};

export const updatePaymentRow = async (
  db: Db,
  paymentId: string,
  fields: PaymentRowFields,
): Promise<void> => {
  const update: Database['public']['Tables']['payments']['Update'] = {};
  if ('grossPhp' in fields && fields.grossPhp != null) update.gross_php = fields.grossPhp;
  if ('haPhp' in fields) update.health_allowance_php = fields.haPhp;
  if ('t13Php' in fields && fields.t13Php != null) update.thirteenth_month_php = fields.t13Php;
  if ('pddPhp' in fields) update.pdd_lunch_php = fields.pddPhp;
  if ('bonusPhp' in fields) update.bonus_php = fields.bonusPhp;
  if ('miscItems' in fields) update.misc_items = fields.miscItems as unknown as Json;
  if ('netPhp' in fields) update.net_php = fields.netPhp;
  if ('payoutMethod' in fields) {
    update.payout_method = fields.payoutMethod as
      | Database['public']['Enums']['payout_method']
      | null;
  }
  if ('fxRate' in fields) update.fx_rate = fields.fxRate;
  if ('note' in fields) update.note = fields.note;
  const { error } = await db.from('payments').update(update).eq('id', paymentId);
  if (error) throw new Error(`update payment: ${error.message}`);
};

/* ---------- NEW: delete statement(s) ---------- */

export const deleteStatement = async (db: Db, paymentId: string): Promise<void> => {
  const { error } = await db.from('payments').delete().eq('id', paymentId);
  if (error) throw new Error(`delete statement: ${error.message}`);
};

/** Delete one worker's payment row for a period (no-op if absent). Used by the
 *  off-cycle single-worker recompute when the worker is left with no payable
 *  activity (e.g. their last off-cycle item was removed). */
export const deleteWorkerPayment = async (
  db: Db,
  payPeriodId: string,
  workerId: string,
): Promise<void> => {
  const { error } = await db
    .from('payments')
    .delete()
    .eq('pay_period_id', payPeriodId)
    .eq('worker_id', workerId);
  if (error) throw new Error(`delete worker payment: ${error.message}`);
};

export const deleteAllStatements = async (db: Db, payPeriodId: string): Promise<number> => {
  const { data, error } = await db
    .from('payments')
    .delete()
    .eq('pay_period_id', payPeriodId)
    .select('id');
  if (error) throw new Error(`delete statements: ${error.message}`);
  return (data ?? []).length;
};

/* ---------- NEW: payments for the process screen ---------- */

export type ProcessPayment = {
  paymentId: string;
  workerId: string;
  name: string;
  netPhp: number | null;
  payoutMethod: string | null;
  status: Database['public']['Enums']['payment_status'];
  paidAt: string | null;
  wiseTransferId: string | null;
  wiseLockedAt: string | null;
  workerStatus: string | null;
  workerEmail: string | null;
};

export const fetchProcessPayments = async (
  db: Db,
  payPeriodId: string,
): Promise<ProcessPayment[]> => {
  const { data, error } = await db
    .from('payments')
    .select(
      'id, worker_id, net_php, payout_method, status, paid_at, wise_transfer_id, wise_locked_at, workers(first_name, middle_name, last_name, status, email)',
    )
    .eq('pay_period_id', payPeriodId)
    .order('worker_id');
  if (error) throw new Error(`process payments: ${error.message}`);
  return (data ?? []).map((p) => ({
    paymentId: p.id,
    workerId: p.worker_id,
    name: [p.workers?.first_name, p.workers?.middle_name, p.workers?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim(),
    netPhp: p.net_php,
    payoutMethod: p.payout_method,
    status: p.status,
    paidAt: p.paid_at,
    wiseTransferId: p.wise_transfer_id,
    wiseLockedAt: p.wise_locked_at,
    workerStatus: p.workers?.status ?? null,
    workerEmail: p.workers?.email ?? null,
  }));
};

/* ---------- NEW: mark paid / unpaid ---------- */

export const markPaymentsPaid = async (
  db: Db,
  paymentIds: string[],
  paidAt: string,
): Promise<void> => {
  if (paymentIds.length === 0) return;
  const { error } = await db
    .from('payments')
    .update({ status: 'sent', paid_at: paidAt })
    .in('id', paymentIds);
  if (error) throw new Error(`mark paid: ${error.message}`);
};

export const markPaymentsUnpaid = async (db: Db, paymentIds: string[]): Promise<void> => {
  if (paymentIds.length === 0) return;
  const { error } = await db
    .from('payments')
    .update({ status: 'draft', paid_at: null })
    .in('id', paymentIds);
  if (error) throw new Error(`mark unpaid: ${error.message}`);
};

export const stepPeriodToLocked = async (db: Db, periodId: string): Promise<void> => {
  const { error } = await db.from('pay_periods').update({ state: 'locked' }).eq('id', periodId);
  if (error) throw new Error(`step to locked: ${error.message}`);
};

/**
 * Keep the documented open->locked->paid machine in sync after a payment-status
 * change: a period with payments that are ALL sent/reconciled becomes 'paid'; a
 * 'paid' period that regains an unpaid payment steps back to 'locked'. 'open'
 * periods are never touched.
 */
export const syncPeriodPaidState = async (db: Db, periodId: string): Promise<void> => {
  const { data: period, error: perr } = await db
    .from('pay_periods')
    .select('state')
    .eq('id', periodId)
    .maybeSingle();
  if (perr) throw new Error(`sync paid state (period): ${perr.message}`);
  if (!period || period.state === 'open') return;
  const { data: pays, error } = await db
    .from('payments')
    .select('status')
    .eq('pay_period_id', periodId);
  if (error) throw new Error(`sync paid state (payments): ${error.message}`);
  const rows = pays ?? [];
  const allDone =
    rows.length > 0 && rows.every((p) => p.status === 'sent' || p.status === 'reconciled');
  if (allDone && period.state !== 'paid') {
    const { error: e } = await db.from('pay_periods').update({ state: 'paid' }).eq('id', periodId);
    if (e) throw new Error(`set paid: ${e.message}`);
  } else if (!allDone && period.state === 'paid') {
    const { error: e } = await db
      .from('pay_periods')
      .update({ state: 'locked' })
      .eq('id', periodId);
    if (e) throw new Error(`unset paid: ${e.message}`);
  }
};

/** Distinct pay_period_ids that the given payment ids belong to. */
export const fetchPeriodIdsForPayments = async (
  db: Db,
  paymentIds: string[],
): Promise<string[]> => {
  if (paymentIds.length === 0) return [];
  const { data, error } = await db.from('payments').select('pay_period_id').in('id', paymentIds);
  if (error) throw new Error(`period ids for payments: ${error.message}`);
  return [...new Set((data ?? []).map((p) => p.pay_period_id))];
};

/* ---------- NEW: wise row lock ---------- */

export const setWiseRowLock = async (
  db: Db,
  paymentId: string,
  lockedAt: string | null,
): Promise<void> => {
  const { error } = await db
    .from('payments')
    .update({ wise_locked_at: lockedAt })
    .eq('id', paymentId);
  if (error) throw new Error(`wise row lock: ${error.message}`);
};

/* ---------- NEW: single payment detail (pay-slip print) ---------- */

export type PaymentDetail = {
  paymentId: string;
  workerId: string;
  name: string;
  companyName: string | null;
  periodStart: string;
  periodEnd: string;
  payDate: string | null;
  grossPhp: number;
  haPhp: number;
  t13Php: number;
  pddPhp: number;
  bonusPhp: number;
  /** Informational performance shortfall (rate − gross); NOT subtracted from net. */
  shortfallPhp: number;
  /** Off-cycle per-session/per-hour earnings on this row (ledger total). */
  offCyclePhp: number;
  /** Stored net snapshot — never recomputed for display. */
  netPhp: number | null;
  miscItems: MiscItem[];
  payoutMethod: string | null;
  payoutCurrency: string | null;
  payoutAmount: number | null;
  fxRate: number | null;
  wiseTransferId: string | null;
  status: Database['public']['Enums']['payment_status'];
  paidAt: string | null;
  note: string | null;
};

/**
 * Full payment row for a pay slip (admin + portal print). Joins pay_periods +
 * workers + companies. `net_php` is the stored snapshot — the slip renders it
 * verbatim and never recomputes. misc_items are mapped exactly like
 * fetchSavedPayments.
 */
export const fetchPaymentDetail = async (
  db: Db,
  paymentId: string,
): Promise<PaymentDetail | null> => {
  const { data, error } = await db
    .from('payments')
    .select(
      'id, worker_id, gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php, bonus_php, deduction_php, off_cycle_php, net_php, misc_items, payout_method, payout_currency, payout_amount, fx_rate, wise_transfer_id, status, paid_at, note, pay_periods(period_start, period_end, pay_date, companies(name)), workers(first_name, middle_name, last_name)',
    )
    .eq('id', paymentId)
    .maybeSingle();
  if (error) throw new Error(`payment detail: ${error.message}`);
  if (!data) return null;
  return {
    paymentId: data.id,
    workerId: data.worker_id,
    name: [data.workers?.first_name, data.workers?.middle_name, data.workers?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim(),
    companyName: data.pay_periods?.companies?.name ?? null,
    periodStart: data.pay_periods?.period_start ?? '',
    periodEnd: data.pay_periods?.period_end ?? '',
    payDate: data.pay_periods?.pay_date ?? null,
    grossPhp: Number(data.gross_php ?? 0),
    haPhp: Number(data.health_allowance_php ?? 0),
    t13Php: Number(data.thirteenth_month_php ?? 0),
    pddPhp: Number(data.pdd_lunch_php ?? 0),
    bonusPhp: Number(data.bonus_php ?? 0),
    shortfallPhp: Number(data.deduction_php ?? 0),
    offCyclePhp: Number(data.off_cycle_php ?? 0),
    netPhp: data.net_php,
    miscItems: Array.isArray(data.misc_items) ? (data.misc_items as MiscItem[]) : [],
    payoutMethod: data.payout_method,
    payoutCurrency: data.payout_currency,
    payoutAmount: data.payout_amount,
    fxRate: data.fx_rate,
    wiseTransferId: data.wise_transfer_id,
    status: data.status,
    paidAt: data.paid_at,
    note: data.note,
  };
};

/** Saved draft/locked snapshot rows for a period (legacy `loadSaved`). */
export const fetchSavedPayments = async (db: Db, payPeriodId: string): Promise<SavedPayment[]> => {
  const { data, error } = await db
    .from('payments')
    .select(
      'id, worker_id, expected_hours, worked_hours, performance_ratio, rate_php, gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php, bonus_php, deduction_php, off_cycle_php, net_php, misc_items, payout_method, note, workers(first_name, middle_name, last_name)',
    )
    .eq('pay_period_id', payPeriodId);
  if (error) throw new Error(`payments: ${error.message}`);
  return (data ?? []).map((p) => ({
    paymentId: p.id,
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
    shortfallPhp: Number(p.deduction_php ?? 0),
    offCyclePhp: Number(p.off_cycle_php ?? 0),
    netPhp: p.net_php,
    miscItems: Array.isArray(p.misc_items) ? (p.misc_items as MiscItem[]) : [],
    payoutMethod: p.payout_method,
    overridden: !!p.note,
  }));
};
