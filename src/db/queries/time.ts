/**
 * Time query module — ALL time_entries DB reads/writes live here.
 * Callers pass an already-created Supabase client (ADR-0002/0003).
 * No inline queries in pages or actions.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { selectAll } from '@/db/queries/paging';
import type { Database } from '@/db/types';
import type { RosterLink } from '@/lib/time/attribution';
import type { TimeEntryRaw } from '@/lib/time/grouping';

type Db = SupabaseClient<Database>;

const ENTRY_COLS =
  'id, worker_id, source_name, work_date, tracked_seconds, pto_seconds, approval, import_batch_id';

/** Unpaid review also needs the approval timestamp — see isEntryUnpaid. */
const UNPAID_COLS = `${ENTRY_COLS}, approved_at`;

const mapEntry = (t: {
  id: string;
  worker_id: string | null;
  source_name: string;
  work_date: string;
  tracked_seconds: number | string | null;
  pto_seconds: number | string | null;
  approval: string;
  import_batch_id: string | null;
}): TimeEntryRaw => ({
  id: t.id,
  workerId: t.worker_id,
  sourceName: t.source_name,
  workDate: t.work_date,
  trackedSeconds: Number(t.tracked_seconds ?? 0),
  ptoSeconds: Number(t.pto_seconds ?? 0),
  approval: t.approval as TimeEntryRaw['approval'],
  importBatchId: t.import_batch_id,
});

// ─── Time entries ────────────────────────────────────────────────────────────

/** All time entries for company+period (all approval states). */
export const fetchPeriodEntries = async (
  db: Db,
  companyId: string,
  start: string,
  end: string,
): Promise<TimeEntryRaw[]> => {
  // Paged: an unbounded select is silently truncated at the server's max_rows
  // and the missing days just don't get paid (63 contractors × 16 days ≈ 1,008).
  const rows = await selectAll(
    (from, to) =>
      db
        .from('time_entries')
        .select(ENTRY_COLS)
        .eq('company_id', companyId)
        .gte('work_date', start)
        .lte('work_date', end)
        .order('work_date', { ascending: true })
        // id breaks work_date ties: paging needs a total order or rows can
        // shuffle between pages and be missed.
        .order('id', { ascending: true })
        .range(from, to),
    'time_entries',
  );
  return rows.map(mapEntry);
};

/**
 * Is this entry still owed money?
 *
 * Pending is always unpaid. Approved is unpaid while its day sits in an OPEN
 * period — and ALSO when it was approved AFTER that period was locked, because
 * the run that closed the period never saw it. That case is real: the nightly
 * sync keeps writing new pending rows into a locked window (the decided-day
 * guard only protects rows that already exist) and approving isn't lock-blocked.
 *
 * Unknown timing — a pre-F8 row with no approved_at, or a period locked without
 * a locked_at stamp — counts as PAID: resurrecting an old approved row into the
 * unpaid view risks paying it a second time, which is the worse failure.
 */
export const isEntryUnpaid = (
  entry: { approval: string; workDate: string; approvedAt: string | null },
  closed: readonly PeriodLockInfo[],
): boolean => {
  if (entry.approval === 'pending') return true;
  const period = closed.find(
    (p) => entry.workDate >= p.periodStart && entry.workDate <= p.periodEnd,
  );
  if (!period) return true;
  if (!period.lockedAt || !entry.approvedAt) return false;
  return Date.parse(entry.approvedAt) > Date.parse(period.lockedAt);
};

/**
 * Cross-period "unpaid" review set:
 *   - every PENDING entry (any date), plus
 *   - APPROVED entries not yet covered by a run (see isEntryUnpaid).
 * Rejected entries are excluded by the query.
 */
export const fetchUnpaidEntries = async (db: Db, companyId: string): Promise<TimeEntryRaw[]> => {
  // Paged — this one is cross-period, so it hits the row cap soonest, and a
  // truncated read would also narrow the lock lookup below.
  const raw = await selectAll(
    (from, to) =>
      db
        .from('time_entries')
        .select(UNPAID_COLS)
        .eq('company_id', companyId)
        .in('approval', ['pending', 'approved'])
        .order('work_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    'time_entries unpaid',
  );
  const first = raw[0];
  const last = raw[raw.length - 1];
  if (!first || !last) return [];

  // Rows are ordered by work_date, so first/last bound the span.
  const closed = await fetchLockedPeriodsInRange(db, companyId, first.work_date, last.work_date);
  return raw
    .filter((r) =>
      isEntryUnpaid(
        { approval: r.approval, workDate: r.work_date, approvedAt: r.approved_at },
        closed,
      ),
    )
    .map(mapEntry);
};

export interface ExistingDay {
  sourceName: string;
  workDate: string;
  approval: 'pending' | 'approved' | 'rejected';
  trackedSeconds: number;
  ptoSeconds: number;
  clientCompanyId: string | null;
  importBatchId: string | null;
}

/** Everything already stored for a set of source_names over a date window.
 *  Feeds the CSV decided-day guard and the "add hours" merge below. */
export const fetchExistingDays = async (
  db: Db,
  companyId: string,
  sourceNames: string[],
  dateMin: string,
  dateMax: string,
): Promise<ExistingDay[]> => {
  if (sourceNames.length === 0) return [];
  const rows = await selectAll(
    (from, to) =>
      db
        .from('time_entries')
        .select(
          'source_name, work_date, approval, tracked_seconds, pto_seconds, client_company_id, import_batch_id',
        )
        .eq('company_id', companyId)
        .in('source_name', sourceNames)
        .gte('work_date', dateMin)
        .lte('work_date', dateMax)
        .order('work_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    'time_entries existing days',
  );
  return rows.map((r) => ({
    sourceName: r.source_name,
    workDate: r.work_date,
    approval: r.approval as ExistingDay['approval'],
    trackedSeconds: Number(r.tracked_seconds ?? 0),
    ptoSeconds: Number(r.pto_seconds ?? 0),
    clientCompanyId: r.client_company_id,
    importBatchId: r.import_batch_id,
  }));
};

/** work_date for a set of entry ids, scoped to the company (edit-total bounds
 *  check — also means an id from another company simply isn't found). */
export const fetchEntryDates = async (
  db: Db,
  companyId: string,
  ids: string[],
): Promise<Array<{ id: string; workDate: string }>> => {
  if (ids.length === 0) return [];
  const { data, error } = await db
    .from('time_entries')
    .select('id, work_date')
    .eq('company_id', companyId)
    .in('id', ids);
  if (error) throw new Error(`entry dates: ${error.message}`);
  return (data ?? []).map((r) => ({ id: r.id, workDate: r.work_date }));
};

const dayKey = (sourceName: string, workDate: string) => `${sourceName}|${workDate}`;

export interface CsvRow {
  sourceName: string;
  workerId: string | null;
  workDate: string;
  trackedSeconds: number;
  activityPct: number | null;
}

/**
 * Re-key CSV rows onto what the SERVER resolved, before anything is written.
 *
 * Two problems, one pass:
 *  - RP-46: the client sends its own name→workerId mapping, so a tampered
 *    payload could attribute hours to any worker. `resolved` is built from the
 *    company roster server-side; the client's workerId is discarded.
 *  - RP-38: after a Hubstaff rename, re-importing the CSV inserts a SECOND set
 *    of rows for the same days under the new name. Both name-match to the same
 *    worker and attributeTimeEntries sums both — the worker is paid twice.
 *    Rewriting source_name to the one that worker's existing rows already use
 *    makes the upsert hit the same (company_id, source_name, work_date) key,
 *    the way the Hubstaff API path already does via resolveSourceName.
 *
 * Rows whose name resolves to nobody keep their name and land unattributed
 * (worker_id null) — same contract as an unmatched Hubstaff sync row.
 */
export const canonicalizeCsvRows = (
  rows: readonly CsvRow[],
  resolved: ReadonlyMap<string, { workerId: string; sourceName: string }>,
): CsvRow[] => {
  const out = new Map<string, CsvRow>();
  for (const r of rows) {
    const hit = resolved.get(r.sourceName);
    const row: CsvRow = {
      ...r,
      workerId: hit?.workerId ?? null,
      sourceName: hit?.sourceName ?? r.sourceName,
    };
    const k = dayKey(row.sourceName, row.workDate);
    const prior = out.get(k);
    // Both spellings of one worker in the SAME file now collapse onto one key.
    // Sum them: a duplicate key inside one upsert batch is a hard Postgres
    // error ("cannot affect row a second time"), and dropping one loses hours.
    if (prior) prior.trackedSeconds += row.trackedSeconds;
    else out.set(k, row);
  }
  return [...out.values()];
};

/**
 * Which CSV rows may actually be written. Two rules apply in BOTH modes:
 *   - a zero-second day carries no information, and in overwrite mode writing
 *     one blanks the day's PTO and re-opens its approval;
 *   - never overwrite a day a human already decided — the same invariant the
 *     Hubstaff sync enforces via fetchExistingDecided, which the CSV path
 *     bypassed entirely.
 * Skip mode additionally drops every key that already exists at all.
 */
export const csvRowsToWrite = <
  T extends { sourceName: string; workDate: string; trackedSeconds: number },
>(
  rows: readonly T[],
  existing: readonly { sourceName: string; workDate: string; approval: string }[],
  mode: 'upsert' | 'skip',
): T[] => {
  const blocked = new Set(
    existing
      .filter((e) => mode === 'skip' || e.approval !== 'pending')
      .map((e) => dayKey(e.sourceName, e.workDate)),
  );
  return rows.filter((r) => r.trackedSeconds > 0 && !blocked.has(dayKey(r.sourceName, r.workDate)));
};

export interface MergedDay {
  sourceName: string;
  workDate: string;
  trackedSeconds: number;
  ptoSeconds: number;
  clientCompanyId: string | null;
  importBatchId: string | null;
}

/**
 * "Add hours" merge. The button says Add: hours SUM onto whatever the day
 * already holds, and its PTO / client attribution survive — a plain upsert on
 * (company_id, source_name, work_date) replaced all three, which mattered
 * because total mode always targets periodStart and that day usually exists.
 *
 * A day someone already approved or rejected is refused rather than silently
 * re-opened; its date comes back in `decided` for the caller to surface.
 */
export const mergeAddedHours = (
  additions: readonly {
    sourceName: string;
    workDate: string;
    seconds: number;
    clientCompanyId: string | null;
    importBatchId: string;
  }[],
  existing: readonly ExistingDay[],
): { merged: MergedDay[]; decided: string[] } => {
  const byKey = new Map(existing.map((e) => [dayKey(e.sourceName, e.workDate), e]));
  const merged: MergedDay[] = [];
  const decided: string[] = [];
  for (const a of additions) {
    const prior = byKey.get(dayKey(a.sourceName, a.workDate));
    if (prior && prior.approval !== 'pending') {
      decided.push(a.workDate);
      continue;
    }
    merged.push({
      sourceName: a.sourceName,
      workDate: a.workDate,
      trackedSeconds: (prior?.trackedSeconds ?? 0) + a.seconds,
      ptoSeconds: prior?.ptoSeconds ?? 0,
      clientCompanyId: a.clientCompanyId ?? prior?.clientCompanyId ?? null,
      // ponytail: a merged day keeps the batch id it already had, so deleting
      // the new "import" can't rip out hours it didn't add. The added hours are
      // therefore not separately undoable — upgrade path is a per-add adjustment
      // row instead of summing in place.
      importBatchId: prior?.importBatchId ?? a.importBatchId,
    });
  }
  return { merged, decided: [...new Set(decided)].sort() };
};

/** Entry dates that fall outside the period being edited. The "all unpaid" view
 *  aggregates several periods into one row and edit-total writes the whole
 *  total onto the earliest entry — across periods that moves hours into a
 *  closed period and zeroes the current one. */
export const datesOutsidePeriod = (
  entries: readonly { workDate: string }[],
  start: string,
  end: string,
): string[] =>
  [
    ...new Set(
      entries.filter((e) => e.workDate < start || e.workDate > end).map((e) => e.workDate),
    ),
  ].sort();

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
    /** CLIENT these hours bill to (invoicing attribution); null = unattributed. */
    client_company_id?: string | null;
  }>,
): Promise<void> => {
  if (rows.length === 0) return;
  const { error } = await db
    .from('time_entries')
    .upsert(rows, { onConflict: 'company_id,source_name,work_date' });
  if (error) throw new Error(`time_entries upsert: ${error.message}`);
};

/**
 * Fetch the current approval values for a set of ids (for undo snapshots).
 *
 * Company-scoped like every write below it: RLS already blocks a genuine
 * cross-tenant read, but a multi-company admin can pass company A with company
 * B's ids, and then the action logs the change against the wrong company. The
 * count the caller gets back is what makes that visible.
 */
export const fetchApprovalSnapshot = async (
  db: Db,
  companyId: string,
  ids: string[],
): Promise<Array<{ id: string; approval: 'pending' | 'approved' | 'rejected' }>> => {
  if (ids.length === 0) return [];
  const { data, error } = await db
    .from('time_entries')
    .select('id, approval')
    .eq('company_id', companyId)
    .in('id', ids);
  if (error) throw new Error(`approval snapshot: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    approval: r.approval as 'pending' | 'approved' | 'rejected',
  }));
};

/**
 * Update approval status for a set of ids (chunked to avoid URL length).
 *
 * F8: stamp approved_at/approved_by when approving so approval timing is
 * auditable at the row level (and detectable relative to a period lock); clear
 * them on reject so the invariant "timing set ⇔ approval='approved'" holds.
 */
export const updateApproval = async (
  db: Db,
  companyId: string,
  ids: string[],
  status: 'approved' | 'rejected',
  actorId?: string | null,
): Promise<void> => {
  const patch =
    status === 'approved'
      ? { approval: status, approved_at: new Date().toISOString(), approved_by: actorId ?? null }
      : { approval: status, approved_at: null, approved_by: null };
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { error } = await db
      .from('time_entries')
      .update(patch)
      .eq('company_id', companyId)
      .in('id', chunk);
    if (error) throw new Error(`approval update: ${error.message}`);
  }
};

/** Restore approval values for a set of id+status pairs (used by undo). */
export const restoreApprovals = async (
  db: Db,
  companyId: string,
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
      // Keep the F8 invariant: clear approval timing when restoring to any
      // non-approved state. (The undo snapshot doesn't carry the original
      // approved_at, so a restore back to 'approved' leaves timing as-is.)
      const patch =
        status === 'approved'
          ? { approval: 'approved' as const }
          : {
              approval: status as 'pending' | 'rejected',
              approved_at: null,
              approved_by: null,
            };
      const { error } = await db
        .from('time_entries')
        .update(patch)
        .eq('company_id', companyId)
        .in('id', ids);
      if (error) throw new Error(`restore approvals: ${error.message}`);
    }
  }
};

/** Update tracked_seconds for a set of ids (used by edit-total). */
export const updateTrackedSeconds = async (
  db: Db,
  companyId: string,
  updates: Array<{ id: string; trackedSeconds: number }>,
): Promise<void> => {
  for (const u of updates) {
    const { error } = await db
      .from('time_entries')
      .update({ tracked_seconds: u.trackedSeconds })
      .eq('company_id', companyId)
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
  /** When the period was locked — the cutoff isEntryUnpaid compares against. */
  lockedAt: string | null;
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
    .select('id, period_start, period_end, state, locked_at')
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
    lockedAt: p.locked_at,
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
