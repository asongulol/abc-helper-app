/**
 * Time query module — ALL time_entries DB reads/writes live here.
 * Callers pass an already-created Supabase client (ADR-0002/0003).
 * No inline queries in pages or actions.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';
import type { RosterLink } from '@/lib/time/attribution';
import type { TimeEntryRaw } from '@/lib/time/grouping';

type Db = SupabaseClient<Database>;

// ─── Time entries ────────────────────────────────────────────────────────────

/** All time entries for company+period (all approval states). */
export const fetchPeriodEntries = async (
  db: Db,
  companyId: string,
  start: string,
  end: string,
): Promise<TimeEntryRaw[]> => {
  const { data, error } = await db
    .from('time_entries')
    .select(
      'id, worker_id, source_name, work_date, tracked_seconds, pto_seconds, approval, import_batch_id',
    )
    .eq('company_id', companyId)
    .gte('work_date', start)
    .lte('work_date', end)
    .order('work_date', { ascending: true });
  if (error) throw new Error(`time_entries: ${error.message}`);
  return (data ?? []).map((t) => ({
    id: t.id,
    workerId: t.worker_id,
    sourceName: t.source_name,
    workDate: t.work_date,
    trackedSeconds: Number(t.tracked_seconds ?? 0),
    ptoSeconds: Number(t.pto_seconds ?? 0),
    approval: t.approval as TimeEntryRaw['approval'],
    importBatchId: t.import_batch_id,
  }));
};

/** Fetch distinct source_names in a company (for unmatched-name detection). */
export const fetchSourceNames = async (
  db: Db,
  companyId: string,
  start: string,
  end: string,
): Promise<string[]> => {
  const { data, error } = await db
    .from('time_entries')
    .select('source_name')
    .eq('company_id', companyId)
    .gte('work_date', start)
    .lte('work_date', end);
  if (error) throw new Error(`time_entries source_names: ${error.message}`);
  return [...new Set((data ?? []).map((r) => r.source_name))];
};

/** Upsert time entries (conflict on company_id,source_name,work_date). */
export const upsertTimeEntries = async (
  db: Db,
  rows: Array<{
    company_id: string;
    worker_id: string | null;
    source_name: string;
    work_date: string;
    tracked_seconds: number;
    pto_seconds: number;
    approval: 'pending' | 'approved' | 'rejected';
    import_batch_id: string | null;
    activity_pct: number | null;
  }>,
): Promise<void> => {
  if (rows.length === 0) return;
  const { error } = await db
    .from('time_entries')
    .upsert(rows, { onConflict: 'company_id,source_name,work_date' });
  if (error) throw new Error(`time_entries upsert: ${error.message}`);
};

/** Fetch the current approval values for a set of ids (for undo snapshots). */
export const fetchApprovalSnapshot = async (
  db: Db,
  ids: string[],
): Promise<Array<{ id: string; approval: 'pending' | 'approved' | 'rejected' }>> => {
  if (ids.length === 0) return [];
  const { data, error } = await db.from('time_entries').select('id, approval').in('id', ids);
  if (error) throw new Error(`approval snapshot: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    approval: r.approval as 'pending' | 'approved' | 'rejected',
  }));
};

/** Update approval status for a set of ids (chunked to avoid URL length). */
export const updateApproval = async (
  db: Db,
  ids: string[],
  status: 'approved' | 'rejected',
): Promise<void> => {
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { error } = await db.from('time_entries').update({ approval: status }).in('id', chunk);
    if (error) throw new Error(`approval update: ${error.message}`);
  }
};

/** Restore approval values for a set of id+status pairs (used by undo). */
export const restoreApprovals = async (
  db: Db,
  entries: Array<{ id: string; approval: 'pending' | 'approved' | 'rejected' }>,
): Promise<void> => {
  const CHUNK = 100;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    // Group by approval value to minimise round-trips.
    const byStatus = new Map<string, string[]>();
    for (const e of chunk) {
      const bucket = byStatus.get(e.approval);
      if (bucket) {
        bucket.push(e.id);
      } else {
        byStatus.set(e.approval, [e.id]);
      }
    }
    for (const [status, ids] of byStatus) {
      const { error } = await db
        .from('time_entries')
        .update({ approval: status as 'pending' | 'approved' | 'rejected' })
        .in('id', ids);
      if (error) throw new Error(`restore approvals: ${error.message}`);
    }
  }
};

/** Update tracked_seconds for a set of ids (used by edit-total). */
export const updateTrackedSeconds = async (
  db: Db,
  updates: Array<{ id: string; trackedSeconds: number }>,
): Promise<void> => {
  for (const u of updates) {
    const { error } = await db
      .from('time_entries')
      .update({ tracked_seconds: u.trackedSeconds })
      .eq('id', u.id);
    if (error) throw new Error(`tracked_seconds update: ${error.message}`);
  }
};

/** Delete entries by batch id (for a specific company). */
export const deleteByBatch = async (
  db: Db,
  companyId: string,
  batchId: string,
): Promise<number> => {
  const { data, error } = await db
    .from('time_entries')
    .delete()
    .eq('company_id', companyId)
    .eq('import_batch_id', batchId)
    .select('id');
  if (error) throw new Error(`delete batch: ${error.message}`);
  return (data ?? []).length;
};

// ─── Roster (for name attribution) ──────────────────────────────────────────

/** Worker roster for the company — used to match source_name → worker_id. */
export const fetchRosterLinks = async (db: Db, companyId: string): Promise<RosterLink[]> => {
  const { data, error } = await db
    .from('worker_companies')
    .select('worker_id, hubstaff_name, status, workers(first_name, middle_name, last_name, status)')
    .eq('company_id', companyId);
  if (error) throw new Error(`worker_companies: ${error.message}`);
  return (data ?? []).map((l) => {
    const w = l.workers;
    const linkInactive = l.status === 'ended';
    const workerInactive = w?.status === 'ended';
    return {
      workerId: l.worker_id,
      hubstaffName: l.hubstaff_name,
      firstName: w?.first_name ?? null,
      middleName: w?.middle_name ?? null,
      lastName: w?.last_name ?? null,
      isInactive: linkInactive || workerInactive,
    };
  });
};

/** Contractor options for the "add unlisted contractor" bottom row.
 *  Returns active workers with their source_name (hubstaff_name preferred). */
export const fetchContractorOptions = async (
  db: Db,
  companyId: string,
): Promise<Array<{ workerId: string; displayName: string; sourceName: string }>> => {
  const { data, error } = await db
    .from('worker_companies')
    .select('worker_id, hubstaff_name, status, workers(first_name, middle_name, last_name)')
    .eq('company_id', companyId)
    .in('status', ['active', 'inactive']);
  if (error) throw new Error(`worker_companies opts: ${error.message}`);
  return (data ?? []).map((l) => {
    const w = l.workers;
    const displayName = [w?.first_name, w?.middle_name, w?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();
    const sourceName = l.hubstaff_name ?? displayName;
    return { workerId: l.worker_id, displayName, sourceName };
  });
};

// ─── Import batches ──────────────────────────────────────────────────────────

export interface BatchRow {
  batchId: string;
  entryCount: number;
  dateMin: string;
  dateMax: string;
  totalSeconds: number;
  firstSourceName: string;
  /** Distinct approval statuses present in the batch. */
  approvalMix: string[];
}

/** Group time_entries by import_batch_id for the import management screen.
 *  Only returns rows that have a non-null import_batch_id. */
export const fetchImportBatches = async (db: Db, companyId: string): Promise<BatchRow[]> => {
  const { data, error } = await db
    .from('time_entries')
    .select('import_batch_id, work_date, tracked_seconds, pto_seconds, source_name, approval')
    .eq('company_id', companyId)
    .not('import_batch_id', 'is', null)
    .order('work_date', { ascending: false });
  if (error) throw new Error(`import batches: ${error.message}`);

  const map = new Map<
    string,
    {
      dates: string[];
      totalSeconds: number;
      sources: string[];
      approvals: Set<string>;
    }
  >();

  for (const row of data ?? []) {
    const bid = row.import_batch_id;
    if (!bid) continue;
    const bucket = map.get(bid);
    if (bucket) {
      bucket.dates.push(row.work_date);
      bucket.totalSeconds += Number(row.tracked_seconds ?? 0) + Number(row.pto_seconds ?? 0);
      bucket.sources.push(row.source_name);
      bucket.approvals.add(row.approval);
    } else {
      map.set(bid, {
        dates: [row.work_date],
        totalSeconds: Number(row.tracked_seconds ?? 0) + Number(row.pto_seconds ?? 0),
        sources: [row.source_name],
        approvals: new Set([row.approval]),
      });
    }
  }

  const result: BatchRow[] = [];
  for (const [batchId, b] of map) {
    const sorted = [...b.dates].sort();
    result.push({
      batchId,
      entryCount: b.dates.length,
      dateMin: sorted[0] ?? '',
      dateMax: sorted[sorted.length - 1] ?? '',
      totalSeconds: b.totalSeconds,
      firstSourceName: b.sources[0] ?? '',
      approvalMix: [...b.approvals],
    });
  }

  // sort by newest date first
  return result.sort((a, b) => b.dateMax.localeCompare(a.dateMax));
};

// ─── Pay periods (for batch-delete lock check) ───────────────────────────────

export interface PeriodLockInfo {
  id: string;
  periodStart: string;
  periodEnd: string;
  state: 'open' | 'locked' | 'paid';
}

/** Check whether any locked/paid periods overlap the given date range. */
export const fetchLockedPeriodsInRange = async (
  db: Db,
  companyId: string,
  dateMin: string,
  dateMax: string,
): Promise<PeriodLockInfo[]> => {
  const { data, error } = await db
    .from('pay_periods')
    .select('id, period_start, period_end, state')
    .eq('company_id', companyId)
    .in('state', ['locked', 'paid'])
    .lte('period_start', dateMax)
    .gte('period_end', dateMin);
  if (error) throw new Error(`pay_periods lock check: ${error.message}`);
  return (data ?? []).map((p) => ({
    id: p.id,
    periodStart: p.period_start,
    periodEnd: p.period_end,
    state: p.state as PeriodLockInfo['state'],
  }));
};

/** Delete open pay_periods with no payments and no approved time in range
 *  (mirrors legacy deleteBatch cleanup of empty draft periods). */
export const deleteEmptyOpenPeriods = async (
  db: Db,
  companyId: string,
  dateMin: string,
  dateMax: string,
): Promise<void> => {
  // Find open periods overlapping the batch date span.
  const { data: openPeriods } = await db
    .from('pay_periods')
    .select('id, period_start, period_end')
    .eq('company_id', companyId)
    .eq('state', 'open')
    .lte('period_start', dateMax)
    .gte('period_end', dateMin);

  if (!openPeriods?.length) return;

  for (const pp of openPeriods) {
    // Check for payments.
    const { count: payCount } = await db
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .eq('pay_period_id', pp.id);
    if ((payCount ?? 0) > 0) continue;

    // Check for remaining approved time in this period.
    const { count: timeCount } = await db
      .from('time_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('approval', 'approved')
      .gte('work_date', pp.period_start)
      .lte('work_date', pp.period_end);
    if ((timeCount ?? 0) > 0) continue;

    // Safe to delete this empty open period.
    await db.from('pay_periods').delete().eq('id', pp.id);
  }
};
