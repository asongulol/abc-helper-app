/**
 * Payroll query module — ALL payroll DB reads/writes live here (no inline
 * queries in actions/routes; ADR-0002/0003). Callers pass an already-created
 * Supabase client: the RLS user client for admin flows, the service client
 * only behind an explicit role check (ADR-0004).
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cache } from 'react';
import { selectAll } from '@/db/queries/paging';
import type { Database, Json } from '@/db/types';
import { periodFor } from '@/lib/dates/periods';
import { type Centavos, centavos, majorToMinor } from '@/lib/money';
import { composeNet, type MiscItem, miscTotal } from '@/lib/pay/calc';
import type { RateRow } from '@/lib/pay/rates';
import {
  centavosToPhp,
  isInactiveWorker,
  type PaymentDraft,
  type RosterRow,
  type TimeEntryRow,
} from '@/lib/payroll/mappers';
import { uuid } from '@/types/schemas/uuid';

type Db = SupabaseClient<Database>;

/** Approved time entries in [start, end] (tracked + paid PTO; legacy step 1). */
export const fetchApprovedTime = async (
  db: Db,
  companyId: string,
  start: string,
  end: string,
): Promise<TimeEntryRow[]> => {
  // RP-11: this feeds gross pay and was unbounded — PostgREST caps an unbounded
  // select at max_rows and drops the overflow silently (63 contractors × a
  // 16-day period is already >1000 rows), so the last workers were underpaid.
  // `.order('id')` gives the paging a stable total order; without it successive
  // ranges can repeat or skip rows.
  const data = await selectAll(
    (from, to) =>
      db
        .from('time_entries')
        .select('worker_id, source_name, work_date, tracked_seconds, pto_seconds, approval')
        .eq('company_id', companyId)
        .gte('work_date', start)
        .lte('work_date', end)
        .eq('approval', 'approved')
        .order('id')
        .range(from, to),
    'time_entries',
  );
  return data.map((t) => ({
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
      'worker_id, contract, pay_basis, hubstaff_name, status, workers(first_name, middle_name, last_name, hire_date, status, payout_method, health_allowance_eligible, health_allowance_date, thirteenth_month_eligible)',
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
        healthAllowanceDate: w?.health_allowance_date ?? null,
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
  basis: 'per_session' | 'per_hour' | 'salaried_hours';
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
  basis:
    r.basis === 'per_hour'
      ? 'per_hour'
      : r.basis === 'salaried_hours'
        ? 'salaried_hours'
        : 'per_session',
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
  perSessionUnitsByWorker: Map<string, number>;
  rows: OffCycleItemRow[];
}> => {
  const byWorkerCentavos = new Map<string, Centavos>();
  const perHourDatesByWorker = new Map<string, Set<string>>();
  const perSessionUnitsByWorker = new Map<string, number>();
  const rows: OffCycleItemRow[] = [];
  if (workerIds.length === 0)
    return { byWorkerCentavos, perHourDatesByWorker, perSessionUnitsByWorker, rows };
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
    if (row.basis === 'per_session') {
      const prevUnits = perSessionUnitsByWorker.get(row.workerId) ?? 0;
      perSessionUnitsByWorker.set(row.workerId, prevUnits + (row.units ?? 0));
    }
  }
  return { byWorkerCentavos, perHourDatesByWorker, perSessionUnitsByWorker, rows };
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

/**
 * Σ units (hours) of existing salaried catch-up rows per worker, keyed on the
 * ORIGINAL period's period_end (salaried_hours rows store it as work_date) —
 * feeds the strict-cap pricing so a second catch-up can't overshoot the rate.
 */
export const fetchSalariedCatchUpUnits = async (
  db: Db,
  companyId: string,
  workDate: string,
  workerIds: string[],
): Promise<Map<string, number>> => {
  const byWorker = new Map<string, number>();
  if (workerIds.length === 0) return byWorker;
  const { data, error } = await db
    .from('off_cycle_pay_items')
    .select('worker_id, units')
    .eq('company_id', companyId)
    .eq('basis', 'salaried_hours')
    .eq('work_date', workDate)
    .in('worker_id', workerIds);
  if (error) throw new Error(`salaried catch-up units: ${error.message}`);
  for (const r of data ?? []) {
    const prev = byWorker.get(r.worker_id) ?? 0;
    byWorker.set(r.worker_id, prev + (Number(r.units) || 0));
  }
  return byWorker;
};

export type NewOffCycleItem = {
  companyId: string;
  workerId: string;
  payPeriodId: string;
  basis: 'per_session' | 'per_hour' | 'salaried_hours';
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

/**
 * Stamp the paid marker on the sessions a REGULAR period's calc just paid — the
 * same set `fetchSessionUnitsByWorkerByDate` summed (approved, in-window,
 * `paid_at IS NULL`), for the per-session workers on the period. Without this a
 * paid session stays unmarked and can be paid a second time off-cycle.
 *
 * One UPDATE per worker so each session records the payment that paid it, and
 * because that stamp is what {@link clearPeriodSessionsPaid} releases on unlock:
 * ledger-held sessions carry a NULL `paid_payment_id` and must survive it.
 * Service client — sessions are CLIENT-company scoped (ADR-0004).
 */
export const markPeriodSessionsPaid = async (
  db: Db,
  workers: readonly { workerId: string; paymentId: string }[],
  periodId: string,
  from: string,
  to: string,
  paidAt: string,
): Promise<void> => {
  for (const w of workers) {
    const { error } = await db
      .from('service_sessions')
      .update({ paid_at: paidAt, paid_pay_period_id: periodId, paid_payment_id: w.paymentId })
      .eq('worker_id', w.workerId)
      .eq('approval', 'approved')
      .is('paid_at', null)
      .gte('session_date', from)
      .lte('session_date', to);
    if (error) throw new Error(`mark period sessions paid: ${error.message}`);
  }
};

/**
 * Release the sessions a lock stamped (period unlocked → payable again).
 * Off-cycle ledger sessions are stamped with a null `paid_payment_id` and are
 * left alone — their pay line still exists and survives the unlock.
 */
export const clearPeriodSessionsPaid = async (db: Db, periodId: string): Promise<void> => {
  const { error } = await db
    .from('service_sessions')
    .update({ paid_at: null, paid_pay_period_id: null, paid_payment_id: null })
    .eq('paid_pay_period_id', periodId)
    .not('paid_payment_id', 'is', null);
  if (error) throw new Error(`clear period sessions paid: ${error.message}`);
};

/**
 * The workers a period pays from SESSIONS: `payments.units` is non-null only on
 * a per_session row (see toPaymentDraft), so it is the marker for "this row's
 * gross is Σ session units × rate" and thus for whose sessions a lock stamps.
 */
export const sessionPaidWorkers = (
  payments: readonly { workerId: string; paymentId: string; units: number | null }[],
): { workerId: string; paymentId: string }[] =>
  payments
    .filter((p) => p.units != null)
    .map((p) => ({ workerId: p.workerId, paymentId: p.paymentId }));

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
  /** NOT NULL in the schema — a persisted row always has a priced gross. */
  grossPhp: number;
  haPhp: number;
  t13Php: number;
  pddPhp: number;
  bonusPhp: number;
  miscItems: MiscItem[];
  /** Engine gross behind a manual override; null = not overridden (RP-07). */
  computedGrossPhp: number | null;
  /** Audit prose, incl. the override line `applyGrossOverride` writes. */
  note: string | null;
};

export const fetchPaymentForWorker = async (
  db: Db,
  payPeriodId: string,
  workerId: string,
): Promise<PaymentComponents | null> => {
  const { data, error } = await db
    .from('payments')
    .select(
      'id, gross_php, computed_gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php, bonus_php, misc_items, note',
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
    computedGrossPhp: data.computed_gross_php == null ? null : Number(data.computed_gross_php),
    note: data.note,
  };
};

/**
 * Net for a surgical (non-rebuilding) write: the stored row's own components
 * plus the ledger total, via composeNet — the same composition as the engine
 * and updatePaymentRowAction, so the three cannot drift. Gross is non-null on
 * every persisted row (schema NOT NULL), so composeNet's null rule never fires
 * here and the result stays a number. Keeping this in one place is what makes
 * the surgical path safe: every column the rebuild would have recomputed is
 * carried through verbatim, so a manual misc/bonus/PDD/gross-override survives
 * (RP-20).
 */
export const composeNetCentavos = (
  c: Pick<PaymentComponents, 'grossPhp' | 'haPhp' | 't13Php' | 'pddPhp' | 'bonusPhp' | 'miscItems'>,
  offCycle: Centavos,
): Centavos =>
  composeNet(centavos(majorToMinor(Number(c.grossPhp))), {
    healthAllowance: centavos(majorToMinor(c.haPhp)),
    thirteenth: centavos(majorToMinor(c.t13Php)),
    pddLunch: centavos(majorToMinor(c.pddPhp)),
    bonus: centavos(majorToMinor(c.bonusPhp)),
    misc: miscTotal(c.miscItems),
    offCycle,
  });

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
  /** Present only on reads that select it (findPeriod); undefined elsewhere. */
  kind?: 'regular' | 'off_cycle';
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
    .select('id, state, kind')
    .eq('company_id', companyId)
    .eq('period_start', start)
    .eq('period_end', end)
    .maybeSingle();
  if (error) throw new Error(`pay_periods: ${error.message}`);
  return data
    ? { id: data.id, state: data.state, kind: data.kind === 'off_cycle' ? 'off_cycle' : 'regular' }
    : null;
};

/** Same lookup by period id, plus the window — a deleted statement only knows
 *  its pay_period_id, and sending its time back to Approval needs the dates. */
export const fetchPeriodById = async (
  db: Db,
  periodId: string,
): Promise<(PeriodRef & { companyId: string; periodStart: string; periodEnd: string }) | null> => {
  const { data, error } = await db
    .from('pay_periods')
    .select('id, state, kind, company_id, period_start, period_end')
    .eq('id', periodId)
    .maybeSingle();
  if (error) throw new Error(`pay_periods: ${error.message}`);
  return data
    ? {
        id: data.id,
        state: data.state,
        kind: data.kind === 'off_cycle' ? 'off_cycle' : 'regular',
        companyId: data.company_id,
        periodStart: data.period_start,
        periodEnd: data.period_end,
      }
    : null;
};

/** The allowance toggles a Calculate ran with — replayed when ONE row is later
 *  rebuilt, so an off-cycle add can't silently change the run's rules (RP-20). */
export type PeriodCalcFlags = { includeHa: boolean; includeThirteenth: boolean };

/** Upsert the period as OPEN (legacy `saveDraft` step). Returns the row.
 *  `flags` are written only by the full Calculate (it is the one caller that
 *  knows them); omitting them leaves an existing period's flags untouched. */
export const upsertOpenPeriod = async (
  db: Db,
  companyId: string,
  start: string,
  end: string,
  payDate: string,
  flags?: PeriodCalcFlags,
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
        ...(flags ? { include_ha: flags.includeHa, include_13: flags.includeThirteenth } : {}),
      },
      { onConflict: 'company_id,period_start,period_end' },
    )
    .select('id, state')
    .single();
  if (error) throw new Error(`pay_periods upsert: ${error.message}`);
  return { id: data.id, state: data.state };
};

/** Thrown when the period exists but is locked/paid — the one closed-period
 *  message shape. Soft callers (reconcile) branch on it by type. */
export class PeriodClosedError extends Error {
  constructor(
    readonly state: 'locked' | 'paid',
    fix: string,
  ) {
    super(`Period is ${state} — ${fix}.`);
    this.name = 'PeriodClosedError';
  }
}

export type OpenPeriodRef = {
  id: string;
  kind: 'regular' | 'off_cycle';
  periodStart: string;
  periodEnd: string;
};

export type RequireOpenPeriodKey =
  | {
      /** By id; `companyId` additionally asserts the period belongs to it. */
      periodId: string;
      companyId?: string;
    }
  | {
      /** By window. Omitting `create` requires the period to exist. */
      companyId: string;
      start: string;
      end: string;
      /** 'missing' inserts an open period when absent; 'always' also refreshes
       *  an existing row's arrears pay_date and calc flags (Calculate — RP-66/RP-20). */
      create?: 'missing' | 'always';
      /** Recorded on insert/refresh only; omitted, an existing row keeps its own. */
      flags?: PeriodCalcFlags;
    };

/**
 * The single open-period gate: look the period up, refuse a locked/paid one
 * with the canonical message (`Period is <state> — <fix>.`), and — by window —
 * create it with the derived ARREARS pay date (periodFor, RP-66), never a
 * caller-supplied one. The guard always runs before any upsert, so a closed
 * period can never be forced back to 'open'.
 */
export const requireOpenPeriod = async (
  db: Db,
  key: RequireOpenPeriodKey,
  fix: string,
): Promise<OpenPeriodRef> => {
  if ('periodId' in key) {
    const p = await fetchPeriodById(db, key.periodId);
    if (!p) throw new Error('Period not found.');
    if (key.companyId && p.companyId !== key.companyId)
      throw new Error('Period not in this company.');
    if (p.state !== 'open') throw new PeriodClosedError(p.state, fix);
    return {
      id: p.id,
      kind: p.kind ?? 'regular',
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
    };
  }
  const existing = await findPeriod(db, key.companyId, key.start, key.end);
  if (existing && existing.state !== 'open') throw new PeriodClosedError(existing.state, fix);
  if (existing && key.create !== 'always')
    return {
      id: existing.id,
      kind: existing.kind ?? 'regular',
      periodStart: key.start,
      periodEnd: key.end,
    };
  if (!existing && !key.create) throw new Error('Period not found.');
  const made = await upsertOpenPeriod(
    db,
    key.companyId,
    key.start,
    key.end,
    periodFor(key.start).payDate,
    key.flags,
  );
  return {
    id: made.id,
    kind: existing?.kind ?? 'regular',
    periodStart: key.start,
    periodEnd: key.end,
  };
};

/** The toggles the period's last Calculate used (RP-20). Falls back to the
 *  historical hardcode (HA on, 13th off) for a period that predates the columns. */
export const fetchPeriodCalcFlags = async (db: Db, periodId: string): Promise<PeriodCalcFlags> => {
  const { data, error } = await db
    .from('pay_periods')
    .select('include_ha, include_13')
    .eq('id', periodId)
    .maybeSingle();
  if (error) throw new Error(`period calc flags: ${error.message}`);
  return { includeHa: data?.include_ha ?? true, includeThirteenth: data?.include_13 ?? false };
};

/**
 * Other regular periods of the same calendar year whose Calculate already ran
 * the 13th-month accrual (RP-29).
 *
 * The accrual is stateless — `calc.ts` adds a full month's thirteenth every time
 * the toggle is ticked, so a second run in the same year pays it twice and the
 * engine cannot see that, because a pure function has no idea what the other
 * periods did. Only this layer can: the toggle is now recorded per period
 * (`include_13`, migration 32), so "already accrued this year" is one read.
 *
 * Deliberately a WARNING, not a block — a 13th month paid in two installments
 * (a May half and a December half) is normal here, and the app must not decide
 * that for the admin. It just has to stop being silent.
 */
export const fetchThirteenthAccrualPeriods = async (
  db: Db,
  companyId: string,
  year: number,
  excludePeriodId: string,
): Promise<string[]> => {
  const { data, error } = await db
    .from('pay_periods')
    .select('id, period_start, period_end')
    .eq('company_id', companyId)
    .eq('include_13', true)
    .gte('period_start', `${year}-01-01`)
    .lte('period_start', `${year}-12-31`)
    .neq('id', excludePeriodId)
    .order('period_start');
  if (error) throw new Error(`13th-month periods: ${error.message}`);
  return (data ?? []).map((p) => `${p.period_start} → ${p.period_end}`);
};

/** Every period's state keyed by `start|end` — maps session dates onto
 *  locked/paid runs for the approve-flow warning. */
export const fetchPeriodStatesByWindow = async (
  db: Db,
  companyId: string,
): Promise<Map<string, Database['public']['Enums']['pay_period_state']>> => {
  const { data, error } = await db
    .from('pay_periods')
    .select('period_start, period_end, state')
    .eq('company_id', companyId);
  if (error) throw new Error(`pay_periods: ${error.message}`);
  return new Map((data ?? []).map((p) => [`${p.period_start}|${p.period_end}`, p.state]));
};

/** Periods in the given states whose window overlaps [start, stop] — the
 *  imports range-delete guard. */
export const fetchPeriodsOverlapping = async (
  db: Db,
  companyId: string,
  start: string,
  stop: string,
  states: Database['public']['Enums']['pay_period_state'][],
): Promise<{ id: string; periodStart: string; periodEnd: string; state: PeriodRef['state'] }[]> => {
  const { data, error } = await db
    .from('pay_periods')
    .select('id, period_start, period_end, state')
    .eq('company_id', companyId)
    .in('state', states)
    .lte('period_start', stop)
    .gte('period_end', start);
  if (error) throw new Error(`pay_periods: ${error.message}`);
  return (data ?? []).map((p) => ({
    id: p.id,
    periodStart: p.period_start,
    periodEnd: p.period_end,
    state: p.state,
  }));
};

export type OpenDraft = { id: string; periodStart: string; periodEnd: string };

/**
 * Pure containment resolver: of the given OPEN regular periods, the one whose
 * [periodStart, periodEnd] window contains `date` (ISO YYYY-MM-DD strings
 * compare correctly lexicographically), or null if none does. A locked period
 * never appears in `periods` (callers only pass state='open' rows), so "no
 * match" also covers the locked-period case (audit #001/#009).
 */
export const resolveOpenDraftForDate = (
  periods: readonly OpenDraft[],
  date: string,
): OpenDraft | null => periods.find((p) => date >= p.periodStart && date <= p.periodEnd) ?? null;

/**
 * Which period /payroll should open on (RP-25). Summaries arrive newest-first,
 * so "the first open draft with statements" landed on the IN-PROGRESS period
 * whenever the legacy sibling app (shared prod DB) had already seeded it with
 * cloned rows — with no admin action, and while the period actually awaiting
 * payroll sat open behind it. Payroll runs a half-month in arrears, so prefer
 * the draft for `arrearsStart` (= previousPeriod(today).start, /time's default),
 * then fall back to the old newest-with-rows / any-open order.
 *
 * Off-cycle batches are never candidates: the caller turns the result into a
 * semi-monthly window via periodFor(), which a batch's `today–today` label
 * cannot represent.
 */
export const preferredOpenDraft = <
  T extends { state: string; kind: string; periodStart: string; contractorCount: number },
>(
  periods: readonly T[],
  arrearsStart: string,
): T | null => {
  const open = periods.filter((p) => p.state === 'open' && p.kind === 'regular');
  return (
    open.find((p) => p.periodStart === arrearsStart) ??
    open.find((p) => p.contractorCount > 0) ??
    open[0] ??
    null
  );
};

/**
 * The employer's OPEN regular draft whose window contains `date`, or null if
 * no open period covers it (none exists, or it's locked). Previously picked
 * the most-recent open draft with no date check at all, which silently paid
 * sessions into an unrelated period (audit #001/#009); now scoped per-date.
 */
export const findCurrentOpenDraft = async (
  db: Db,
  companyId: string,
  date: string,
): Promise<OpenDraft | null> => {
  const { data, error } = await db
    .from('pay_periods')
    .select('id, period_start, period_end')
    .eq('company_id', companyId)
    .eq('kind', 'regular')
    .eq('state', 'open');
  if (error) throw new Error(`current draft: ${error.message}`);
  const periods = (data ?? []).map((d) => ({
    id: d.id,
    periodStart: d.period_start,
    periodEnd: d.period_end,
  }));
  return resolveOpenDraftForDate(periods, date);
};

export type OffCycleBatch = {
  id: string;
  periodStart: string;
  periodEnd: string;
  isNew: boolean;
};

/**
 * Today in the OFFICE's calendar — the label an off-cycle batch is created
 * with. `new Date().toISOString()` is UTC, so a New York admin working after
 * ~8 PM opened a batch stamped TOMORROW (RP-67). 'en-CA' formats as YYYY-MM-DD;
 * same Intl approach the portal already uses for its Manila day bucket.
 *
 * ponytail: the office zone is a constant. Make it a company setting the day a
 * second office runs payroll.
 */
export const OFFICE_TIME_ZONE = 'America/New_York';
export const officeToday = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: OFFICE_TIME_ZONE }).format(now);

/**
 * The employer's single OPEN off-cycle batch (kind='off_cycle'), creating one
 * dated `today` if none exists. The date window is a label only — an off-cycle
 * batch is paid purely from its off_cycle_pay_items (the regular calc is guarded
 * against it), so the window intentionally captures no hours/sessions.
 *
 * pay_date is also `today`: off-cycle means "pay now, off the schedule". It
 * previously took periodFor(today).payDate — the IN-PROGRESS period's arrears
 * pay date, 15–30 days out — which mislabeled a pay-now batch (ProcessPay
 * header + mark-paid default date).
 */
export const findOrCreateOffCycleBatch = async (
  db: Db,
  companyId: string,
  today: string,
): Promise<OffCycleBatch> => {
  const findOpen = async (): Promise<OffCycleBatch | null> => {
    const { data: open, error: findErr } = await db
      .from('pay_periods')
      .select('id, period_start, period_end')
      .eq('company_id', companyId)
      .eq('kind', 'off_cycle')
      .eq('state', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (findErr) throw new Error(`off-cycle batch lookup: ${findErr.message}`);
    return open
      ? {
          id: open.id,
          periodStart: open.period_start,
          periodEnd: open.period_end,
          isNew: false,
        }
      : null;
  };

  const open = await findOpen();
  if (open) return open;

  const { data: created, error: insErr } = await db
    .from('pay_periods')
    .insert({
      company_id: companyId,
      period_start: today,
      period_end: today,
      pay_date: today,
      state: 'open',
      kind: 'off_cycle',
    })
    .select('id, period_start, period_end')
    .single();
  if (insErr) {
    // pay_periods_off_cycle_open_uniq (migration 41): a concurrent open won the
    // race between our lookup and this insert — adopt the batch it created.
    if (insErr.code === '23505') {
      const raced = await findOpen();
      if (raced) return raced;
    }
    throw new Error(`off-cycle batch create: ${insErr.message}`);
  }
  return {
    id: created.id,
    periodStart: created.period_start,
    periodEnd: created.period_end,
    isNew: true,
  };
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
  // `note` rides along only on the single-row rebuild that re-arms a gross
  // override (mergeManualColumns) — a batch recalc never sets it, so the bulk
  // payload's keys stay uniform.
  drafts: readonly (PaymentDraft & { note?: string })[],
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
 * Park the pre-recalc snapshot ON the period (RP-23). It used to travel to the
 * browser and back, so every money column, `status` and `paid_at` came in as
 * whatever the caller sent; server-held, the undo needs no client rows at all.
 * Best-effort by design is NOT acceptable here — a silent failure would leave a
 * stale snapshot that a later undo would restore as if it were current.
 */
export const savePriorPayments = async (
  db: Db,
  periodId: string,
  rows: readonly PaymentSnapshotRow[],
): Promise<void> => {
  const { error } = await db
    .from('pay_periods')
    .update({ prior_payments: rows as unknown as Json })
    .eq('id', periodId);
  if (error) throw new Error(`save prior payments: ${error.message}`);
};

/** The server-held pre-recalc snapshot for a period, or [] when there is none. */
export const fetchPriorPayments = async (
  db: Db,
  periodId: string,
): Promise<PaymentSnapshotRow[]> => {
  const { data, error } = await db
    .from('pay_periods')
    .select('prior_payments')
    .eq('id', periodId)
    .maybeSingle();
  if (error) throw new Error(`prior payments: ${error.message}`);
  return Array.isArray(data?.prior_payments)
    ? (data.prior_payments as unknown as PaymentSnapshotRow[])
    : [];
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

/**
 * True if this app has recorded a `recalculate` for this period (the durable
 * once-guard for the carried-over auto-recalc). `calculateDraft` logs it with
 * `entity = "${start} → ${end}"`; a legacy-app clone leaves no such event.
 */
export const hasInAppRecalc = async (
  db: Db,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<boolean> => {
  const { data, error } = await db
    .from('audit_log')
    .select('id')
    .eq('company_id', companyId)
    .eq('action', 'recalculate')
    .eq('entity', `${periodStart} → ${periodEnd}`)
    .limit(1);
  if (error) throw new Error(`recalc audit check: ${error.message}`);
  return (data ?? []).length > 0;
};

/** Id of the most-recent regular period ending before `beforeStart`, or null. */
export const fetchPreviousRegularPeriodId = async (
  db: Db,
  companyId: string,
  beforeStart: string,
): Promise<string | null> => {
  const { data, error } = await db
    .from('pay_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('kind', 'regular')
    .lt('period_end', beforeStart)
    .order('period_end', { ascending: false })
    .limit(1);
  if (error) throw new Error(`previous period: ${error.message}`);
  return data?.[0]?.id ?? null;
};

export type SavedPayment = {
  /** UUID of the payments row — required for updatePaymentRowAction / deleteStatement. */
  paymentId: string;
  workerId: string;
  /** Full legal name (first middle last) — used by the payslip / Wise / exports. */
  name: string;
  /** First + last only — table display (less clutter); never used for payout. */
  displayName: string;
  /** Approved session count — non-null ONLY on a per_session row. */
  units: number | null;
  expectedHours: number;
  workedHours: number;
  ratio: number;
  ratePhp: number | null;
  grossPhp: number | null;
  /** The engine's gross, kept while gross_php holds an override; null = none (RP-07). */
  computedGrossPhp: number | null;
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
  /** Worker or company link is no longer active — lock-time warning (RP-18). */
  inactive: boolean;
};

/* ---------- NEW: list periods with summary totals ---------- */

export type PeriodSummaryRow = {
  id: string;
  state: Database['public']['Enums']['pay_period_state'];
  /** 'regular' semi-monthly period or an 'off_cycle' catch-up batch. */
  kind: 'regular' | 'off_cycle';
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
 * Reads the pay_period_summaries view (migration 0027): Postgres does the
 * count/sum, so this is ONE round-trip returning one row per period — the old
 * shape fetched every payments row ever and aggregated in JS on every admin
 * page load. The view is security_invoker, so the pay_periods/payments RLS
 * still applies.
 *
 * `cache()`-wrapped: the admin layout loads period summaries for the ⌘K palette
 * on every page, and /overview, /payroll, /batches load them again. One cached
 * Supabase client means a single query per request. Keyed on (db, companyId).
 */
export const fetchPeriodSummaries = cache(
  async (db: Db, companyId: string): Promise<PeriodSummaryRow[]> => {
    const { data, error } = await db
      .from('pay_period_summaries')
      .select(
        'id, state, kind, period_start, period_end, pay_date, locked_at, contractor_count, total_net_php',
      )
      .eq('company_id', companyId)
      .order('period_start', { ascending: false });
    if (error) throw new Error(`pay_periods: ${error.message}`);
    // Generated view types are nullable (Postgres can't prove NOT NULL through
    // the GROUP BY), but id/state/dates come straight from pay_periods rows —
    // nulls cannot occur. Guard instead of casting.
    return (data ?? []).flatMap((p) =>
      p.id && p.period_start && p.period_end
        ? [
            {
              id: p.id,
              state: p.state ?? 'open',
              kind: p.kind === 'off_cycle' ? ('off_cycle' as const) : ('regular' as const),
              periodStart: p.period_start,
              periodEnd: p.period_end,
              payDate: p.pay_date,
              lockedAt: p.locked_at,
              contractorCount: p.contractor_count ?? 0,
              totalNetCentavos: Math.round(Number(p.total_net_php ?? 0) * 100),
            },
          ]
        : [],
    );
  },
);

/* ---------- NEW: lock / unlock period ---------- */

/**
 * Transition period to 'locked'. Caller must verify no null-rate rows first.
 *
 * RP-03: pay_date is deliberately NOT written here. The period already carries
 * the correct arrears date from upsertOpenPeriod (periodFor().payDate); locking
 * used to overwrite it with period_end — a date BEFORE the payment window even
 * opens (Mar 1–15 is paid by Mar 31, Mar 16–31 by Apr 15).
 */
export const lockPeriod = async (db: Db, periodId: string): Promise<void> => {
  const { error } = await db
    .from('pay_periods')
    .update({
      state: 'locked',
      locked_at: new Date().toISOString(),
    })
    .eq('id', periodId);
  if (error) throw new Error(`lock period: ${error.message}`);
};

/**
 * Salaried catch-up ledger rows that pay leftover hours FROM the period ending
 * `periodEnd` (a salaried_hours row stores the ORIGINAL period's end as its
 * work_date). Company-wide, not scoped to the period's current payment rows: a
 * worker pruned from the period would still be rebuilt by a recalc.
 */
export const fetchSalariedCatchUpsForPeriodEnd = async (
  db: Db,
  companyId: string,
  periodEnd: string,
): Promise<{ workerName: string; units: number | null }[]> => {
  const { data, error } = await db
    .from('off_cycle_pay_items')
    .select('units, workers(first_name, last_name)')
    .eq('company_id', companyId)
    .eq('basis', 'salaried_hours')
    .eq('work_date', periodEnd);
  if (error) throw new Error(`salaried catch-ups: ${error.message}`);
  return (data ?? []).map((r) => ({
    workerName: [r.workers?.first_name, r.workers?.last_name].filter(Boolean).join(' ').trim(),
    units: r.units,
  }));
};

/**
 * Why a period must NOT be locked yet, or null when it is safe. Both blockers
 * are "work that exists but the draft doesn't pay", i.e. a silent UNDERPAY:
 *
 *  - F2: time entries still `pending` in the window are invisible to
 *    fetchApprovedTime, so their hours are simply missing from gross.
 *  - RP-22: approved, unpaid, in-window `service_sessions` beyond what the draft
 *    captured (`payments.units`). A per-session worker's session that lands
 *    AFTER the last Calculate — the OffCycleModal's "Add session" pane creates
 *    pre-approved ones, so it is one click away — is in neither the draft nor
 *    the lock's paid-stamp (which stamps exactly the workers the calc summed).
 *    A worker with sessions but no row at all captured 0 and is fully unpaid.
 *
 * An OFF-CYCLE batch is exempt from both. Its window is the label `today–today`,
 * so today's unrelated pending time is not its work (RP-34, and the "recalculate"
 * the message asks for isn't even offered for a batch), and its pay comes from
 * the ledger rather than from anything the window captures.
 */
export const lockBlockedReason = (
  kind: 'regular' | 'off_cycle',
  pendingTimeCount: number,
  payments: readonly { workerId: string; name: string; units: number | null }[],
  sessionUnitsByWorker: ReadonlyMap<string, number>,
  offCycleSessionUnitsByWorker: ReadonlyMap<string, number> = new Map(),
): string | null => {
  if (kind === 'off_cycle') return null;
  if (pendingTimeCount > 0)
    return `${pendingTimeCount} time entr${pendingTimeCount === 1 ? 'y is' : 'ies are'} still pending approval in this period. Approve or reject them before locking, then recalculate.`;
  const byWorker = new Map(payments.map((p) => [p.workerId, p]));
  // `payments.units` counts every session the row pays, INCLUDING the ones paid
  // off the ledger. Those are already stamped paid, so they're absent from
  // `sessionUnitsByWorker` — leaving them in the comparison would let a ledger
  // payment silently cover for the same number of brand-new unpaid sessions.
  const captured = (workerId: string) =>
    (byWorker.get(workerId)?.units ?? 0) - (offCycleSessionUnitsByWorker.get(workerId) ?? 0);
  const missed = [...sessionUnitsByWorker]
    .filter(([workerId, units]) => units > captured(workerId))
    .map(([workerId]) => byWorker.get(workerId)?.name || 'Unnamed worker');
  if (missed.length > 0)
    return `${missed.length} contractor(s) have approved sessions in this period that this draft does not pay (${missed.join(', ')}). Recalculate before locking.`;
  return null;
};

/**
 * Rows the admin should look at before locking, or null when there is nothing
 * to warn about (RP-18). Unlike lockBlockedReason these are NOT hard blocks:
 * paying a contractor whose link just ended is legitimate, it just must not
 * happen silently — which is what it did, because `confirmed` was never read
 * and the inactive flag never left the engine.
 */
export const lockWarningReason = (
  payments: readonly { name: string; inactive: boolean; payoutMethod: string | null }[],
  confirmed: boolean,
): string | null => {
  if (confirmed) return null;
  const named = (rows: readonly { name: string }[]) =>
    rows.map((p) => p.name || 'Unnamed worker').join(', ');
  const parts: string[] = [];
  const inactive = payments.filter((p) => p.inactive);
  if (inactive.length > 0)
    parts.push(`${inactive.length} inactive contractor(s) (${named(inactive)})`);
  const noMethod = payments.filter((p) => !p.payoutMethod);
  if (noMethod.length > 0)
    parts.push(`${noMethod.length} with no payout method (${named(noMethod)})`);
  if (parts.length === 0) return null;
  return `This run pays ${parts.join(' and ')}. Lock again to confirm.`;
};

const OVERRIDE_NOTE = 'Gross manually overridden';

/**
 * The gross-override state machine (RP-07). `computedGrossPhp` is captured on
 * the FIRST override and left alone afterwards — re-deriving it from the stored
 * gross (which by then IS the override) is what destroyed the engine's figure
 * and made the ↺ button restore the override to itself.
 *
 * `note` is now prose only — the revertible value lives in the column, and
 * `overridden` is read from the column too. It is still written for the audit
 * trail, but a note this function did NOT write survives a clear: 287 prod rows
 * carry "Historical import (Hubstaff daily report)" and every routine save used
 * to blank it (and, while `overridden` came from the note, showed them as
 * manually overridden).
 */
export const applyGrossOverride = (
  cur: { grossPhp: number; computedGrossPhp: number | null; note: string | null },
  overridePhp: number | null,
): { grossPhp: number; computedGrossPhp: number | null; note: string | null } => {
  const computed = cur.computedGrossPhp ?? cur.grossPhp;
  if (overridePhp == null)
    return {
      grossPhp: computed,
      computedGrossPhp: null,
      note: cur.note?.startsWith(OVERRIDE_NOTE) ? null : (cur.note ?? null),
    };
  return {
    grossPhp: overridePhp,
    computedGrossPhp: computed,
    note: `${OVERRIDE_NOTE} (computed ${computed})`,
  };
};

/**
 * Carry a row's MANUAL columns across a single-worker rebuild (RP-20).
 *
 * `recomputeWorkerDraft` runs the engine for one worker and upserts the result,
 * so gross/HA/13th/off-cycle are correctly rebuilt — but Misc items, bonus, PDD
 * lunch and a gross override are not engine outputs at all. They exist only on
 * the stored row, and an upsert of the raw draft silently deleted them: adding a
 * single off-cycle session to a contractor who had a ₱3,000 bonus dropped the
 * bonus, with no confirm and no undo.
 *
 * The engine still owns everything it computes — that is why this is a merge and
 * not the surgical `setPaymentOffCycle` write: every caller but the salaried
 * catch-up marks or frees sessions, which legitimately moves gross, so gross
 * MUST be rebuilt. The override is re-armed against the NEW engine gross, so ↺
 * reverts to what the engine would pay today rather than a stale figure.
 *
 * One exception (#84): a zero HA/13th from the engine does NOT overwrite a
 * non-zero stored one — see the comment on those two lines.
 */
export const mergeManualColumns = (
  draft: PaymentDraft,
  manual: PaymentComponents | null,
): PaymentDraft & { note?: string } => {
  if (!manual) return draft;
  const gross =
    manual.computedGrossPhp == null || manual.grossPhp == null
      ? null
      : applyGrossOverride(
          { grossPhp: draft.gross_php, computedGrossPhp: null, note: manual.note },
          manual.grossPhp,
        );
  const merged: PaymentDraft = {
    ...draft,
    ...(gross ? { gross_php: gross.grossPhp, computed_gross_php: gross.computedGrossPhp } : {}),
    // #84: a single-row rebuild must never ZERO an allowance the row already
    // carries. Since 7b35dae the engine pays HA/13th only while a contractor is
    // active, so approving one straggler entry (or adding an off-cycle item) for
    // someone benched after the batch was calculated silently wiped a genuinely
    // earned ₱20,000 — and HA pays in exactly ONE anniversary period a year with
    // no carry-forward, so that is the whole year gone, not one batch. A
    // non-zero engine figure still wins (rate/months changes are the engine's);
    // deliberately clearing an allowance is a hand edit to 0, or the full
    // Recalculate, which does not merge.
    health_allowance_php: draft.health_allowance_php || manual.haPhp,
    thirteenth_month_php: draft.thirteenth_month_php || manual.t13Php,
    pdd_lunch_php: manual.pddPhp,
    bonus_php: manual.bonusPhp,
    misc_items: manual.miscItems,
  };
  const netPhp = centavosToPhp(
    composeNetCentavos(
      {
        grossPhp: merged.gross_php,
        haPhp: merged.health_allowance_php,
        t13Php: merged.thirteenth_month_php,
        pddPhp: merged.pdd_lunch_php,
        bonusPhp: merged.bonus_php,
        miscItems: merged.misc_items,
      },
      centavos(majorToMinor(merged.off_cycle_php)),
    ),
  );
  return {
    ...merged,
    net_php: netPhp,
    payout_amount: netPhp,
    ...(gross?.note ? { note: gross.note } : {}),
  };
};

/**
 * Why a locked period must NOT be unlocked yet, or null when it is safe.
 *
 * Unlocking is only "reopen the draft" on paper — once open, a recalc rewrites
 * net_php and pruneDraftPaymentsExcept can delete rows outright:
 *  - RP-10: a payment carrying a wise_transfer_id has a LIVE draft in Wise built
 *    from the old amount. Recalc/prune leaves that draft funded-and-unmatched
 *    with nothing in the app pointing at it, so the transfer must be cancelled
 *    in Wise first.
 *  - RP-12: a salaried catch-up keyed to this period's end pays hours that a
 *    recalc would fold back into gross — the same hours paid twice. The JSDoc
 *    on addSalariedCatchUp has always said "remove the catch-up first"; this is
 *    what enforces it.
 *
 * ponytail: ANY non-null wise_transfer_id blocks. The app stores no Wise-side
 * transfer state, so a funded or cancelled transfer is indistinguishable from a
 * live draft — an admin whose transfer is already funded has no in-app escape.
 * Upgrade path: persist the transfer state (or clear the id on reconcile) and
 * narrow this to genuinely live drafts.
 */
export const unlockBlockedReason = (
  payments: readonly { name: string; wiseTransferId: string | null }[],
  catchUps: readonly { workerName: string; units: number | null }[],
): string | null => {
  const reasons: string[] = [];
  const drafted = payments.filter((p) => p.wiseTransferId).map((p) => p.name || 'Unnamed worker');
  if (drafted.length > 0)
    reasons.push(
      `${drafted.length} payment(s) already have a Wise transfer drafted (${drafted.join(', ')}). Cancel the transfer(s) in Wise first, then unlock.`,
    );
  const items = catchUps.map((c) =>
    c.units == null
      ? c.workerName || 'Unnamed worker'
      : `${c.workerName || 'Unnamed worker'} (${c.units}h)`,
  );
  if (items.length > 0)
    reasons.push(
      `${items.length} salaried catch-up item(s) already pay hours from this period (${items.join(', ')}). Remove them first, or recalculating will pay those hours twice.`,
    );
  return reasons.length > 0 ? reasons.join(' ') : null;
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
  computedGrossPhp?: number | null;
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
  // Explicit null clears the capture — must not be skipped like grossPhp above.
  if ('computedGrossPhp' in fields) update.computed_gross_php = fields.computedGrossPhp;
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

/** Delete one payment row, returning its scope (null if already gone) so the
 *  caller can release the off-cycle ledger + sessions that fed it. */
export const deleteStatement = async (
  db: Db,
  paymentId: string,
): Promise<{ payPeriodId: string; workerId: string } | null> => {
  const { data, error } = await db
    .from('payments')
    .delete()
    .eq('id', paymentId)
    .select('pay_period_id, worker_id')
    .maybeSingle();
  if (error) throw new Error(`delete statement: ${error.message}`);
  return data ? { payPeriodId: data.pay_period_id, workerId: data.worker_id } : null;
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

/** Session ids a ledger discard must un-mark. Manual / per-hour / catch-up
 *  rows carry no session_id and must not leak nulls into the clear. */
export const sessionIdsToRelease = (rows: readonly { session_id: string | null }[]): string[] =>
  rows.flatMap((r) => (r.session_id ? [r.session_id] : []));

/**
 * Discard the off-cycle ledger rows behind deleted statement(s) — the whole
 * period, or one worker's row — returning the session ids they held paid so
 * the caller can clear the sessions' paid markers. The ledger must go WITH the
 * statements: left behind it re-applies on the next recalculate, and its
 * unique session index blocks ever re-paying the sessions.
 */
export const deleteOffCycleItemsForStatements = async (
  db: Db,
  payPeriodId: string,
  workerId?: string,
): Promise<string[]> => {
  let q = db.from('off_cycle_pay_items').delete().eq('pay_period_id', payPeriodId);
  if (workerId) q = q.eq('worker_id', workerId);
  const { data, error } = await q.select('session_id');
  if (error) throw new Error(`discard off-cycle items: ${error.message}`);
  return sessionIdsToRelease(data ?? []);
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
  /** Wise recipient UUID — the `recipientId` column of a Wise batch-upload CSV. */
  wiseRecipientUuid: string | null;
  /** Numeric Wise recipient id — shown in the individual-payments export. */
  wiseRecipientId: number | null;
  /** Saved Wise recipients ({id,label}) — options for the API-draft dropdown. */
  wiseRecipients: { id: number; label: string }[];
};

export const fetchProcessPayments = async (
  db: Db,
  payPeriodId: string,
): Promise<ProcessPayment[]> => {
  const { data, error } = await db
    .from('payments')
    .select(
      'id, worker_id, net_php, payout_method, status, paid_at, wise_transfer_id, wise_locked_at, workers(first_name, middle_name, last_name, status, email, wise_recipient_uuid, wise_recipient_id, wise_recipients)',
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
    wiseRecipientUuid: p.workers?.wise_recipient_uuid ?? null,
    wiseRecipientId: p.workers?.wise_recipient_id ?? null,
    wiseRecipients: Array.isArray(p.workers?.wise_recipients)
      ? (p.workers.wise_recipients as Array<{ id?: unknown; label?: unknown }>)
          .filter((r) => r && typeof r.id === 'number')
          .map((r) => ({
            id: r.id as number,
            label: String(r.label ?? `Recipient ${r.id as number}`),
          }))
      : [],
  }));
};

/* ---------- NEW: mark paid / unpaid ---------- */

/**
 * The period states in which money may be marked moved. "Paying requires
 * locked" was enforced ONLY by the /process page's routing, and migration 18
 * deliberately leaves `status`/`paid_at` editable in any state — but server
 * actions are HTTP endpoints, so posting an OPEN period's payment ids flipped
 * rows to 'sent' in the middle of a calculation whose amounts are still being
 * rewritten (RP-52). 'paid' is included so a re-mark, or a reversal on a fully
 * paid period, still works.
 */
export const PAYABLE_PERIOD_STATES: readonly Database['public']['Enums']['pay_period_state'][] = [
  'locked',
  'paid',
];

/** Why this set of periods may not have its payments marked, or null. */
export const unpayablePeriodReason = (
  states: readonly Database['public']['Enums']['pay_period_state'][],
  /** What the caller is about to do, for the message ("marked", "drafted into Wise"). */
  verb = 'marked',
): string | null => {
  const bad = [...new Set(states.filter((s) => !PAYABLE_PERIOD_STATES.includes(s)))];
  if (bad.length === 0) return null;
  return `Payments can only be ${verb} once their period is locked — this selection includes ${bad.join(' / ')} period(s). Lock the period first.`;
};

/** Distinct period states behind the given payment ids (RP-52 gate). */
export const fetchPeriodStatesForPayments = async (
  db: Db,
  paymentIds: string[],
): Promise<Database['public']['Enums']['pay_period_state'][]> => {
  if (paymentIds.length === 0) return [];
  const { data, error } = await db
    .from('payments')
    .select('pay_periods(state)')
    .in('id', paymentIds);
  if (error) throw new Error(`period states for payments: ${error.message}`);
  return [...new Set((data ?? []).flatMap((p) => (p.pay_periods ? [p.pay_periods.state] : [])))];
};

/** One period's state (RP-52 gate for the whole-period actions). */
/** Does this period belong to this company? Guards actions the client scopes. */
export const periodBelongsToCompany = async (
  db: Db,
  periodId: string,
  companyId: string,
): Promise<boolean> => {
  if (!uuid().safeParse(periodId).success) return false;
  const { data, error } = await db
    .from('pay_periods')
    .select('company_id')
    .eq('id', periodId)
    .maybeSingle();
  if (error) throw new Error(`period company: ${error.message}`);
  return data?.company_id === companyId;
};

export const fetchPeriodState = async (
  db: Db,
  periodId: string,
): Promise<Database['public']['Enums']['pay_period_state'] | null> => {
  const { data, error } = await db
    .from('pay_periods')
    .select('state')
    .eq('id', periodId)
    .maybeSingle();
  if (error) throw new Error(`period state: ${error.message}`);
  return data?.state ?? null;
};

/**
 * Statuses "mark paid" may move to 'sent'. RP-08: 'sent' and 'reconciled' are
 * excluded — a reconciled row's money is already confirmed and its paid_at is
 * the REAL Wise send date; re-marking regressed the status and overwrote that
 * date with today, silently corrupting reporting.
 */
export const MARKABLE_PAID_STATUSES = ['draft', 'queued', 'failed'] as const;

/** Mark payments sent. Returns the number of rows ACTUALLY updated — RLS and
 *  the status filter can both match fewer rows than were requested (RP-61). */
export const markPaymentsPaid = async (
  db: Db,
  paymentIds: string[],
  paidAt: string,
): Promise<number> => {
  if (paymentIds.length === 0) return 0;
  const { data, error } = await db
    .from('payments')
    .update({ status: 'sent', paid_at: paidAt })
    .in('id', paymentIds)
    .in('status', MARKABLE_PAID_STATUSES)
    .select('id');
  if (error) throw new Error(`mark paid: ${error.message}`);
  return (data ?? []).length;
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
  // Stored computation inputs for the "How this pay was computed" basis line
  // (never recomputed).
  workedHours: number | null;
  expectedHours: number | null;
  performanceRatio: number | null;
  ratePhp: number | null;
  computedGrossPhp: number | null;
  units: number | null;
  perSession: boolean;
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
  // Route params can be anything a user types in the URL; a non-UUID id would
  // otherwise hit Postgres and throw "invalid input syntax for type uuid".
  // Treat that the same as "not found" so callers' existing notFound() runs.
  if (!uuid().safeParse(paymentId).success) return null;
  const { data, error } = await db
    .from('payments')
    .select(
      'id, worker_id, gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php, bonus_php, deduction_php, off_cycle_php, net_php, misc_items, payout_method, payout_currency, payout_amount, fx_rate, wise_transfer_id, status, paid_at, note, worked_hours, expected_hours, performance_ratio, rate_php, computed_gross_php, units, contract, pay_basis, pay_periods(period_start, period_end, pay_date, companies(name)), workers(first_name, middle_name, last_name)',
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
    workedHours: data.worked_hours == null ? null : Number(data.worked_hours),
    expectedHours: data.expected_hours == null ? null : Number(data.expected_hours),
    performanceRatio: data.performance_ratio == null ? null : Number(data.performance_ratio),
    ratePhp: data.rate_php == null ? null : Number(data.rate_php),
    computedGrossPhp: data.computed_gross_php == null ? null : Number(data.computed_gross_php),
    units: data.units == null ? null : Number(data.units),
    perSession: data.contract === 'PS' || data.pay_basis === 'per_session',
  };
};

/** Saved draft/locked snapshot rows for a period (legacy `loadSaved`). */
export const fetchSavedPayments = async (db: Db, payPeriodId: string): Promise<SavedPayment[]> => {
  const { data, error } = await db
    .from('payments')
    .select(
      'id, worker_id, company_id, units, expected_hours, worked_hours, performance_ratio, rate_php, gross_php, computed_gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php, bonus_php, deduction_php, off_cycle_php, net_php, misc_items, payout_method, note, workers(first_name, middle_name, last_name, status, worker_companies(company_id, status))',
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
    displayName: [p.workers?.first_name, p.workers?.last_name].filter(Boolean).join(' ').trim(),
    units: p.units == null ? null : Number(p.units),
    expectedHours: Number(p.expected_hours ?? 0),
    workedHours: Number(p.worked_hours ?? 0),
    ratio: Number(p.performance_ratio ?? 0),
    ratePhp: p.rate_php,
    grossPhp: p.gross_php,
    computedGrossPhp: p.computed_gross_php == null ? null : Number(p.computed_gross_php),
    haPhp: Number(p.health_allowance_php ?? 0),
    t13Php: Number(p.thirteenth_month_php ?? 0),
    pddPhp: Number(p.pdd_lunch_php ?? 0),
    bonusPhp: Number(p.bonus_php ?? 0),
    shortfallPhp: Number(p.deduction_php ?? 0),
    offCyclePhp: Number(p.off_cycle_php ?? 0),
    netPhp: p.net_php,
    miscItems: Array.isArray(p.misc_items) ? (p.misc_items as MiscItem[]) : [],
    payoutMethod: p.payout_method,
    // The capture IS the override marker. Sniffing `note` instead flagged 287
    // prod rows whose note is "Historical import (Hubstaff daily report)" as
    // manually overridden — blue cell, ↺ button, and a recalculate warning.
    overridden: p.computed_gross_php != null,
    // RP-18: same rule as buildStatements — either side of the link going
    // non-active makes the row a warning. The embed returns every company the
    // worker is linked to, so pick this payment's own link.
    inactive: isInactiveWorker(
      p.workers?.status ?? null,
      (p.workers?.worker_companies ?? []).find((l) => l.company_id === p.company_id)?.status ??
        null,
    ),
  }));
};
