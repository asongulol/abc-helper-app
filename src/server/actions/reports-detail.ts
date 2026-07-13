'use server';

/**
 * Reports server actions — faithful port of the legacy `Reports()` data layer
 * (legacy app/index.html ~7484-8376). The legacy SPA read the full payments /
 * time_entries sets in the browser; in the App Router we do the same reads
 * server-side (RLS user client) and hand the client component plain,
 * serializable rows so it can render the five report blocks without any extra
 * round-trips for the main view.
 *
 * - `getReportsData`     → KPI strip + Payout-by-period + Contractor Pay Summary
 * - `getContractorHistory` → per-contractor pay & hours history (lazy, per pick)
 * - `getUtilization`     → avg. weekly activity for the picked contractor(s)
 *
 * All money values cross the wire in PHP major units (numbers), matching the
 * legacy `payments.*_php` columns. The client renders them with money()/peso().
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabase } from '@/db/clients/server';
import type { Database } from '@/db/types';
import { periodFor } from '@/lib/dates/periods';
import { humanizeError } from '@/lib/errors';
import type { ActionResult } from '@/server/actions/portal-admin';
import { getCurrentAdmin } from '@/server/auth/admin';

type Db = SupabaseClient<Database>;

/** Joined `workers` row → "First Middle Last" (legacy `fullName`). */
const workerName = (
  w: {
    first_name?: string | null;
    middle_name?: string | null;
    last_name?: string | null;
  } | null,
): string => [w?.first_name, w?.middle_name, w?.last_name].filter(Boolean).join(' ').trim();

// PostgREST caps a single select at 1000 rows. The grand-total cards and the
// year-to-date summary must not silently under-report, so we page the full set
// (HEAD count, then sequential ranges) — the same correctness fix the legacy
// app applied via `pageAll`.
const PAGE = 1000;

async function pageAll<T>(
  head: () => PromiseLike<{
    count: number | null;
    error: { message: string } | null;
  }>,
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const { count, error: ce } = await head();
  if (ce) throw new Error(ce.message);
  const total = count ?? 0;
  if (total === 0) return [];
  const out: T[] = [];
  for (let from = 0; from < total; from += PAGE) {
    const to = Math.min(from + PAGE - 1, total - 1);
    const { data, error } = await range(from, to);
    if (error) throw new Error(error.message);
    if (data) out.push(...data);
  }
  return out;
}

const PAID = (status: string | null): boolean => status === 'sent' || status === 'reconciled';

const miscSum = (items: unknown): number =>
  Array.isArray(items)
    ? items.reduce((s: number, it) => {
        const a = Number((it as { amount?: unknown })?.amount) || 0;
        return s + ((it as { kind?: unknown })?.kind === 'deduction' ? -a : a);
      }, 0)
    : 0;

// ---------------------------------------------------------------------------
// Shared row types (plain, serializable — sent to the client component)
// ---------------------------------------------------------------------------

export type PeriodContractorRow = {
  name: string;
  hours: number | null;
  rate: number;
  gross: number;
  ha: number;
  t13: number;
  lunch: number;
  bonus: number;
  miscEarn: number;
  miscDeduct: number;
  perfShort: number;
  net: number;
  method: string | null;
  status: string;
};

export type PeriodRow = {
  key: string;
  start: string;
  end: string;
  payDate: string | null;
  count: number;
  net: number;
  usdRef: number;
  unpaid: number;
  fx: number | null;
  rows: PeriodContractorRow[];
};

export type SummaryStatementRow = {
  start: string;
  end: string;
  payDate: string | null;
  hours: number;
  gross: number;
  ha: number;
  t13: number;
  lunch: number;
  bonus: number;
  misc: number;
  ded: number;
  net: number;
  status: string | null;
};

export type SummaryWorkerRow = {
  gkey: string;
  workerId: string;
  name: string;
  periods: number;
  hours: number;
  gross: number;
  ha: number;
  t13: number;
  lunch: number;
  bonus: number;
  misc: number;
  ded: number;
  net: number;
  paid: number;
  statements: SummaryStatementRow[];
};

export type ReportsData = {
  periods: PeriodRow[];
  grandNet: number;
  grandUsd: number;
  grandUnpaid: number;
  /** Every contractor seen in any payment — drives the Summary picker. */
  contractors: Array<{ id: string; name: string }>;
  /** Every worker linked to this company (legacy ContractorHistory picker lists
   *  all workers, even those with only time and no pay yet). */
  workers: Array<{ id: string; name: string }>;
  /** Full per-contractor aggregate over ALL payments — the client slices this
   *  by date window + selected contractors entirely client-side, matching the
   *  legacy in-browser filtering. */
  summary: SummaryWorkerRow[];
};

type PaymentJoin = {
  worker_id: string;
  worked_hours: number | null;
  rate_php: number | null;
  gross_php: number;
  health_allowance_php: number;
  pdd_lunch_php: number;
  bonus_php: number;
  thirteenth_month_php: number;
  deduction_php: number;
  misc_items: unknown;
  net_php: number;
  fx_rate: number | null;
  status: string;
  payout_method: string | null;
  pay_periods: {
    period_start: string;
    period_end: string;
    pay_date: string | null;
    state: string;
  } | null;
  workers: {
    first_name: string;
    middle_name: string | null;
    last_name: string;
  } | null;
};

const PAYMENT_SELECT =
  'worker_id,worked_hours,rate_php,gross_php,health_allowance_php,pdd_lunch_php,' +
  'bonus_php,thirteenth_month_php,deduction_php,misc_items,net_php,fx_rate,status,payout_method,' +
  'pay_periods(period_start,period_end,pay_date,state),' +
  'workers(first_name,middle_name,last_name)';

const guardAccess = async (
  companyId: string,
): Promise<{ ok: true; db: Db } | { ok: false; error: string }> => {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }
  const db = await createServerSupabase();
  return { ok: true, db };
};

/**
 * KPI strip + Payout-by-period + Contractor Pay Summary, all derived from the
 * full payments set for the selected company. Faithful port of the legacy
 * `Reports()` / `PerContractorSummary()` computations.
 */
export async function getReportsData(companyId: string): Promise<ActionResult<ReportsData>> {
  const guard = await guardAccess(companyId);
  if (!guard.ok) return guard;
  const { db } = guard;

  // Kick off the full-roster query now so it overlaps the payments pagination
  // below — they share no data (workerMap derives only from this result).
  const wcsPromise = Promise.resolve(
    db
      .from('worker_companies')
      .select('worker_id, workers(first_name, middle_name, last_name)')
      .eq('company_id', companyId),
  );

  let pays: PaymentJoin[];
  try {
    pays = await pageAll<PaymentJoin>(
      () =>
        db
          .from('payments')
          .select('worker_id', { count: 'exact', head: true })
          .eq('company_id', companyId),
      (from, to) =>
        db
          .from('payments')
          .select(PAYMENT_SELECT)
          .eq('company_id', companyId)
          .order('pay_period_id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
          data: PaymentJoin[] | null;
          error: { message: string } | null;
        }>,
    );
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Reports query failed.'),
    };
  }

  // --- Payout by pay period (group by period, keep contractor lines) ---------
  const byPeriod = new Map<string, PeriodRow>();
  for (const p of pays) {
    const pp = p.pay_periods;
    const key = `${pp?.period_start}|${pp?.period_end}`;
    const g =
      byPeriod.get(key) ??
      ({
        key,
        start: pp?.period_start ?? '',
        end: pp?.period_end ?? '',
        payDate: pp?.pay_date ?? null,
        count: 0,
        net: 0,
        usdRef: 0,
        unpaid: 0,
        fx: p.fx_rate,
        rows: [],
      } satisfies PeriodRow);
    g.count++;
    g.net += Number(p.net_php || 0);
    g.usdRef += p.fx_rate ? Number(p.net_php || 0) / Number(p.fx_rate) : 0;
    if (!PAID(p.status)) g.unpaid += Number(p.net_php || 0);

    const items = Array.isArray(p.misc_items)
      ? (p.misc_items as Array<Record<string, unknown>>)
      : [];
    const miscDeduct = items
      .filter((x) => x.kind === 'deduction')
      .reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const miscEarn = items
      .filter((x) => x.kind !== 'deduction')
      .reduce((s, x) => s + (Number(x.amount) || 0), 0);

    g.rows.push({
      name: workerName(p.workers) || '(unknown)',
      hours: p.worked_hours,
      rate: Number(p.rate_php || 0),
      gross: Number(p.gross_php || 0),
      ha: Number(p.health_allowance_php || 0),
      lunch: Number(p.pdd_lunch_php || 0),
      bonus: Number(p.bonus_php || 0),
      t13: Number(p.thirteenth_month_php || 0),
      perfShort: Number(p.deduction_php || 0),
      miscEarn,
      miscDeduct,
      net: Number(p.net_php || 0),
      method: p.payout_method,
      status: p.status,
    });
    byPeriod.set(key, g);
  }
  const periods = Array.from(byPeriod.values()).sort((a, b) =>
    (b.start || '').localeCompare(a.start || ''),
  );
  const grandNet = periods.reduce((s, p) => s + p.net, 0);
  const grandUnpaid = periods.reduce((s, p) => s + p.unpaid, 0);
  const grandUsd = periods.reduce((s, p) => s + (p.usdRef || 0), 0);

  // --- Contractor Pay Summary (aggregate per worker over all payments) -------
  const optMap = new Map<string, string>();
  const byWorker = new Map<string, SummaryWorkerRow>();
  for (const p of pays) {
    if (!p.worker_id) continue;
    if (!optMap.has(p.worker_id)) optMap.set(p.worker_id, workerName(p.workers) || '(unknown)');
    const key = p.worker_id;
    const g =
      byWorker.get(key) ??
      ({
        gkey: key,
        workerId: p.worker_id,
        name: workerName(p.workers) || '(unknown)',
        periods: 0,
        hours: 0,
        gross: 0,
        ha: 0,
        t13: 0,
        lunch: 0,
        bonus: 0,
        misc: 0,
        ded: 0,
        net: 0,
        paid: 0,
        statements: [],
      } satisfies SummaryWorkerRow);
    const mi = miscSum(p.misc_items);
    g.periods++;
    g.hours += Number(p.worked_hours || 0);
    g.gross += Number(p.gross_php || 0);
    g.ha += Number(p.health_allowance_php || 0);
    g.t13 += Number(p.thirteenth_month_php || 0);
    g.lunch += Number(p.pdd_lunch_php || 0);
    g.bonus += Number(p.bonus_php || 0);
    g.misc += mi;
    g.ded += Number(p.deduction_php || 0);
    g.net += Number(p.net_php || 0);
    if (PAID(p.status)) g.paid += Number(p.net_php || 0);
    g.statements.push({
      start: p.pay_periods?.period_start || '',
      end: p.pay_periods?.period_end || '',
      payDate: p.pay_periods?.pay_date ?? null,
      hours: Number(p.worked_hours || 0),
      gross: Number(p.gross_php || 0),
      ha: Number(p.health_allowance_php || 0),
      t13: Number(p.thirteenth_month_php || 0),
      lunch: Number(p.pdd_lunch_php || 0),
      bonus: Number(p.bonus_php || 0),
      misc: mi,
      ded: Number(p.deduction_php || 0),
      net: Number(p.net_php || 0),
      status: p.status,
    });
    byWorker.set(key, g);
  }
  for (const g of byWorker.values()) {
    g.statements.sort((a, b) => b.start.localeCompare(a.start));
  }
  const summary = Array.from(byWorker.values()).sort((a, b) => a.name.localeCompare(b.name));
  const contractors = Array.from(optMap.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Full worker roster for this company (history picker lists everyone, not
  // just paid contractors). Faithful to legacy ContractorHistory. Query was
  // kicked off above; await its already-in-flight result here.
  const { data: wcs, error: we } = await wcsPromise;
  if (we) return { ok: false, error: we.message };
  const workerMap = new Map<string, string>();
  for (const wc of wcs ?? []) {
    if (!workerMap.has(wc.worker_id)) {
      workerMap.set(wc.worker_id, workerName(wc.workers) || '(unknown)');
    }
  }
  const workers = Array.from(workerMap.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    ok: true,
    data: {
      periods,
      grandNet,
      grandUsd,
      grandUnpaid,
      contractors,
      workers,
      summary,
    },
  };
}

// ---------------------------------------------------------------------------
// Contractor pay & hours history (lazy per pick)
// ---------------------------------------------------------------------------

export type HistoryDay = { date: string; tracked: number; pto: number };

export type HistoryRow = {
  start: string;
  end: string;
  worked: number | null;
  pto: number;
  hasPay: boolean;
  days: HistoryDay[];
  ha: number | null;
  lunch: number | null;
  t13: number | null;
  gross: number | null;
  net: number | null;
  method: string | null;
  status: string | null;
};

/**
 * Per-contractor: every pay period stacked — worked hours + PTO (from
 * time_entries, bucketed by semi-monthly period) merged with pay components
 * from the saved pay statement. Faithful port of legacy `ContractorHistory`.
 */
export async function getContractorHistory(
  companyId: string,
  workerId: string,
): Promise<ActionResult<{ rows: HistoryRow[] }>> {
  const guard = await guardAccess(companyId);
  if (!guard.ok) return guard;
  const { db } = guard;

  try {
    const { data: pays, error: pe } = await db
      .from('payments')
      .select(
        'worked_hours,gross_php,health_allowance_php,pdd_lunch_php,thirteenth_month_php,bonus_php,net_php,payout_method,status,pay_periods(period_start,period_end,pay_date)',
      )
      .eq('worker_id', workerId)
      .eq('company_id', companyId);
    if (pe) throw new Error(pe.message);

    const { data: te, error: te_e } = await db
      .from('time_entries')
      .select('work_date,tracked_seconds,pto_seconds')
      .eq('worker_id', workerId)
      .eq('company_id', companyId)
      .order('work_date', { ascending: true })
      .limit(5000);
    if (te_e) throw new Error(te_e.message);

    type TBucket = {
      end: string;
      tracked: number;
      pto: number;
      days: Map<string, HistoryDay>;
    };
    const tmap = new Map<string, TBucket>();
    for (const r of te ?? []) {
      const p = periodFor(r.work_date);
      const g = tmap.get(p.start) ?? {
        end: p.end,
        tracked: 0,
        pto: 0,
        days: new Map<string, HistoryDay>(),
      };
      g.tracked += Number(r.tracked_seconds || 0);
      g.pto += Number(r.pto_seconds || 0);
      const d = g.days.get(r.work_date) ?? {
        date: r.work_date,
        tracked: 0,
        pto: 0,
      };
      d.tracked += Number(r.tracked_seconds || 0);
      d.pto += Number(r.pto_seconds || 0);
      g.days.set(r.work_date, d);
      tmap.set(p.start, g);
    }

    type PBucket = {
      end: string;
      ha: number;
      lunch: number;
      t13: number;
      gross: number;
      net: number;
      method: string | null;
      status: string;
      workedPay: number | null;
    };
    const pmap = new Map<string, PBucket>();
    for (const p of pays ?? []) {
      const s = p.pay_periods?.period_start;
      if (!s) continue;
      pmap.set(s, {
        end: p.pay_periods?.period_end ?? '',
        ha: Number(p.health_allowance_php || 0),
        lunch: Number(p.pdd_lunch_php || 0),
        t13: Number(p.thirteenth_month_php || 0),
        gross: Number(p.gross_php || 0),
        net: Number(p.net_php || 0),
        method: p.payout_method,
        status: p.status,
        workedPay: p.worked_hours,
      });
    }

    const keys = Array.from(new Set([...tmap.keys(), ...pmap.keys()])).sort((a, b) =>
      b.localeCompare(a),
    );
    const rows: HistoryRow[] = keys.map((k) => {
      const t = tmap.get(k);
      const p = pmap.get(k);
      return {
        start: k,
        end: p?.end || t?.end || '',
        worked:
          t?.tracked != null ? t.tracked / 3600 : p?.workedPay != null ? Number(p.workedPay) : null,
        pto: (t?.pto || 0) / 3600,
        hasPay: !!p,
        days: Array.from(t?.days.values() ?? [])
          .filter((x) => x.tracked > 0 || x.pto > 0)
          .sort((a, b) => a.date.localeCompare(b.date)),
        ha: p ? p.ha : null,
        lunch: p ? p.lunch : null,
        t13: p ? p.t13 : null,
        gross: p ? p.gross : null,
        net: p ? p.net : null,
        method: p ? p.method : null,
        status: p ? p.status : null,
      };
    });
    return { ok: true, data: { rows } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'History query failed.'),
    };
  }
}

// ---------------------------------------------------------------------------
// Avg. weekly activity (Utilization)
// ---------------------------------------------------------------------------

export type UtilizationRow = {
  workerId: string;
  name: string;
  week: string;
  act: number | null;
  hours: number;
};

export type UtilizationData = {
  contractors: Array<{ id: string; name: string }>;
  rows: UtilizationRow[];
  anyActivity: boolean;
};

/** Monday-anchored week-start (ISO) for an ISO date. */
const weekStart = (ds: string): string => {
  if (!ds) return '';
  const d = new Date(`${ds}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  const off = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - off);
  return d.toISOString().slice(0, 10);
};

/**
 * Avg. Hubstaff activity % per contractor per week (Mon–Sun) from approved time.
 * Faithful port of legacy `UtilizationReport`. `workerIds` is the picked set;
 * pass an empty array to get only the contractor options (empty rows).
 */
export async function getUtilization(
  companyId: string,
  workerIds: string[],
): Promise<ActionResult<UtilizationData>> {
  const guard = await guardAccess(companyId);
  if (!guard.ok) return guard;
  const { db } = guard;

  type TeRow = {
    worker_id: string | null;
    source_name: string;
    work_date: string;
    tracked_seconds: number;
    activity_pct: number | null;
  };

  let te: TeRow[];
  try {
    te = await pageAll<TeRow>(
      () =>
        db
          .from('time_entries')
          .select('worker_id', { count: 'exact', head: true })
          .eq('approval', 'approved')
          .eq('company_id', companyId),
      (from, to) =>
        db
          .from('time_entries')
          .select('worker_id,source_name,work_date,tracked_seconds,activity_pct')
          .eq('approval', 'approved')
          .eq('company_id', companyId)
          .order('work_date', { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
          data: TeRow[] | null;
          error: { message: string } | null;
        }>,
    );
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Activity query failed.'),
    };
  }

  const optMap = new Map<string, string>();
  for (const t of te) {
    const id = String(t.worker_id || t.source_name || '');
    if (id && !optMap.has(id)) optMap.set(id, t.source_name || '(unknown)');
  }
  const contractors = Array.from(optMap.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const sel = new Set(workerIds);
  type Bucket = {
    name: string;
    week: string;
    actSum: number;
    actN: number;
    hours: number;
  };
  const byKey = new Map<string, Bucket>();
  let anyActivity = false;
  for (const t of te) {
    const id = String(t.worker_id || t.source_name || '');
    if (!sel.has(id)) continue;
    const wk = weekStart(t.work_date);
    if (!wk) continue;
    const k = `${id}|${wk}`;
    const g = byKey.get(k) ?? {
      name: optMap.get(id) ?? '(unknown)',
      week: wk,
      actSum: 0,
      actN: 0,
      hours: 0,
    };
    g.hours += (t.tracked_seconds || 0) / 3600;
    if (t.activity_pct != null) {
      g.actSum += Number(t.activity_pct);
      g.actN++;
      anyActivity = true;
    }
    byKey.set(k, g);
  }
  const rows: UtilizationRow[] = Array.from(byKey.entries())
    .map(([k, g]) => ({
      workerId: k.split('|')[0] ?? '',
      name: g.name,
      week: g.week,
      act: g.actN ? Number((g.actSum / g.actN).toFixed(1)) : null,
      hours: Number(g.hours.toFixed(1)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || b.week.localeCompare(a.week));

  return { ok: true, data: { contractors, rows, anyActivity } };
}
