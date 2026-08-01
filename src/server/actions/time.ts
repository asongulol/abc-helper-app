'use server';

/**
 * Time server actions — verify admin → Zod validate → query module → audit log.
 * No inline SQL. No money math. Legacy audit action names preserved:
 *   'manual_hours', 'approve_time', 'delete_import'
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabase } from '@/db/clients/server';
import { fetchCanonicalSourceNames } from '@/db/queries/hubstaff';
import {
  canonicalizeCsvRows,
  csvRowsToWrite,
  datesOutsidePeriod,
  deleteByBatch,
  deleteEmptyOpenPeriods,
  fetchApprovalSnapshot,
  fetchEntryDates,
  fetchExistingDays,
  fetchLockedPeriodsInRange,
  fetchRosterLinks,
  mergeAddedHours,
  restoreApprovals,
  updateApproval,
  updateTrackedSeconds,
  upsertTimeEntries,
} from '@/db/queries/time';
import type { Database } from '@/db/types';
import { periodFor } from '@/lib/dates/periods';
import { humanizeError } from '@/lib/errors';
import { resolveSourceName } from '@/lib/hubstaff/transform';
import type { ApprovalUndoEntry } from '@/lib/time/approvalUndo';
import { buildUndoPayload } from '@/lib/time/approvalUndo';
import { buildMatchIndex, matchName } from '@/lib/time/attribution';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import { syncApprovedTimeToDrafts } from '@/server/payroll';
import {
  AddHoursDailySchema,
  AddHoursTotalSchema,
  CsvImportSchema,
  DeleteBatchSchema,
  EditTotalSchema,
  SetApprovalSchema,
  UndoApprovalSchema,
} from '@/types/schemas/time';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const authGuard = async (companyId: string) => {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false as const, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(companyId)) {
    return { ok: false as const, error: 'No access to this company.' };
  }
  return { ok: true as const, admin };
};

/**
 * Shared write path for both manual-hours modes: read the target days first,
 * SUM onto them and keep their PTO/attribution (the button says Add), and
 * refuse outright when one of them is already approved or rejected.
 */
const addHoursMerged = async (
  db: SupabaseClient<Database>,
  args: {
    companyId: string;
    workerId: string | null;
    sourceName: string;
    clientId: string | null;
    batchId: string;
    additions: Array<{ workDate: string; seconds: number }>;
  },
): Promise<{ ok: true; droppedAfterEnd: number } | { ok: false; error: string }> => {
  const { companyId, workerId, sourceName, clientId, batchId, additions } = args;
  const dates = additions.map((a) => a.workDate).sort();
  const dateMin = dates[0];
  const dateMax = dates[dates.length - 1];
  if (!dateMin || !dateMax) return { ok: false, error: 'No dates to add hours to.' };

  const existing = await fetchExistingDays(db, companyId, [sourceName], dateMin, dateMax);
  const { merged, decided } = mergeAddedHours(
    additions.map((a) => ({
      sourceName,
      workDate: a.workDate,
      seconds: a.seconds,
      clientCompanyId: clientId,
      importBatchId: batchId,
    })),
    existing,
  );
  if (decided.length > 0) {
    return {
      ok: false,
      error: `Cannot add hours — ${decided.join(', ')} already approved or rejected. Undo that decision first, then add.`,
    };
  }

  const droppedAfterEnd = await upsertTimeEntries(
    db,
    merged.map((m) => ({
      company_id: companyId,
      worker_id: workerId,
      source_name: m.sourceName,
      work_date: m.workDate,
      tracked_seconds: m.trackedSeconds,
      pto_seconds: m.ptoSeconds,
      approval: 'pending' as const,
      import_batch_id: m.importBatchId,
      activity_pct: null,
      client_company_id: m.clientCompanyId,
    })),
  );
  // Nothing written at all — "Hours added" would be a lie, so that's an error.
  // A PARTIAL drop is not an error (the days on or before the last day did
  // write), but it must not read as clean success either: it rides back as a
  // count the panels report, same as the CSV import summary. Reachable in normal
  // use — the per-row Add-hours panel renders for any contractor with rows in
  // the period, and a departed contractor's pre-termination pending rows are
  // exactly that. ponytail: a count, not the dates. Return the dropped
  // work_dates if admins need to know which days to re-enter elsewhere.
  if (droppedAfterEnd === merged.length && merged.length > 0) {
    return {
      ok: false,
      error: `Those days fall after ${sourceName}'s last day — their engagement has ended.`,
    };
  }
  return { ok: true, droppedAfterEnd };
};

// ─── Approval ────────────────────────────────────────────────────────────────

/**
 * Push the just-decided entries onto Calculate. The approval itself is already
 * committed by the time this runs, so a failure here must NOT fail the action —
 * it comes back as a note the UI shows, never a silent no-op.
 */
const transferToCalculate = async (
  companyId: string,
  entries: readonly { workerId: string | null; workDate: string }[],
): Promise<{ moved: number; calcNote?: string }> => {
  try {
    const { workers, closedPeriods } = await syncApprovedTimeToDrafts({ companyId, entries });
    if (closedPeriods.length > 0) {
      return {
        moved: workers,
        calcNote: `${closedPeriods.join(', ')} is already locked or paid — those hours stayed off Calculate. Use the catch-up card or an off-cycle run.`,
      };
    }
    return { moved: workers };
  } catch (err) {
    return {
      moved: 0,
      calcNote: humanizeError(err, 'Saved the approval, but updating Calculate failed.'),
    };
  }
};

/** Approve or reject a set of time entries; returns prior approval values for undo. */
export async function setTimeApproval(args: unknown): Promise<
  ActionResult<{
    count: number;
    undoEntries: ApprovalUndoEntry[];
    /** Contractor rows built or merged onto the Calculate batch. */
    moved: number;
    calcNote?: string | undefined;
  }>
> {
  const parsed = SetApprovalSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const { companyId, ids, status } = parsed.data;

  const guard = await authGuard(companyId);
  if (!guard.ok) return guard;

  try {
    const db = await createServerSupabase();
    // Snapshot BEFORE update so we can undo. Company-scoped, so a short read
    // means some id doesn't belong to this company — refuse rather than log the
    // approval against the wrong company (RP-45).
    const snapshot = await fetchApprovalSnapshot(db, companyId, ids);
    if (snapshot.length !== ids.length) {
      return { ok: false, error: 'Some of those entries no longer exist — refresh and try again.' };
    }
    await updateApproval(db, companyId, ids, status, guard.admin.userId);
    await logEvent({
      companyId,
      action: 'approve_time',
      entity: companyId,
      detail: { ids_count: ids.length, status },
    });
    const undoEntries = buildUndoPayload(snapshot, status);
    // Both directions: approving builds the row, rejecting rebuilds it smaller
    // (or drops it), so a retracted entry can't stay on a batch waiting to be paid.
    const { moved, calcNote } = await transferToCalculate(companyId, snapshot);
    return { ok: true, data: { count: ids.length, undoEntries, moved, calcNote } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Approval update failed.'),
    };
  }
}

/** Undo a prior approve/reject by restoring the previous approval values. */
export async function undoApproval(
  args: unknown,
): Promise<ActionResult<{ count: number; calcNote?: string | undefined }>> {
  const parsed = UndoApprovalSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const { companyId, entries } = parsed.data;

  const guard = await authGuard(companyId);
  if (!guard.ok) return guard;

  try {
    const db = await createServerSupabase();
    await restoreApprovals(db, companyId, entries);
    await logEvent({
      companyId,
      action: 'approve_time',
      entity: companyId,
      detail: { ids_count: entries.length, status: 'undo' },
    });
    // Read AFTER the restore: the batch has to be rebuilt from the approval state
    // that now holds, or undoing an approval leaves its hours sitting on Calculate.
    const touched = await fetchApprovalSnapshot(
      db,
      companyId,
      entries.map((e) => e.id),
    );
    const { calcNote } = await transferToCalculate(companyId, touched);
    return { ok: true, data: { count: entries.length, calcNote } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Undo failed.'),
    };
  }
}

// ─── Manual hours ─────────────────────────────────────────────────────────────

/** Add total hours for a contractor (total mode → first day of period only). */
export async function addHoursTotal(
  args: unknown,
): Promise<ActionResult<{ batchId: string; droppedAfterEnd: number }>> {
  const parsed = AddHoursTotalSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const { companyId, workerId, sourceName, periodStart, hours, clientId } = parsed.data;

  const guard = await authGuard(companyId);
  if (!guard.ok) return guard;

  const batchId = crypto.randomUUID();
  try {
    const db = await createServerSupabase();
    const written = await addHoursMerged(db, {
      companyId,
      workerId,
      sourceName,
      clientId: clientId ?? null,
      batchId,
      additions: [{ workDate: periodStart, seconds: Math.round(hours * 3600) }],
    });
    if (!written.ok) return written;
    const period = periodFor(periodStart);
    await logEvent({
      companyId,
      action: 'manual_hours',
      entity: sourceName,
      detail: {
        period: `${period.start} → ${period.end}`,
        hours: +hours.toFixed(2),
        mode: 'total',
        dropped_after_end: written.droppedAfterEnd,
      },
    });
    return { ok: true, data: { batchId, droppedAfterEnd: written.droppedAfterEnd } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Could not add hours.'),
    };
  }
}

/** Add daily hours for a contractor (only days with hours > 0). */
export async function addHoursDaily(
  args: unknown,
): Promise<ActionResult<{ batchId: string; droppedAfterEnd: number }>> {
  const parsed = AddHoursDailySchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const { companyId, workerId, sourceName, days, clientId } = parsed.data;

  const guard = await authGuard(companyId);
  if (!guard.ok) return guard;

  const batchId = crypto.randomUUID();
  try {
    const db = await createServerSupabase();
    const written = await addHoursMerged(db, {
      companyId,
      workerId,
      sourceName,
      clientId: clientId ?? null,
      batchId,
      additions: days.map((d) => ({ workDate: d.date, seconds: Math.round(d.hours * 3600) })),
    });
    if (!written.ok) return written;
    const totalHours = days.reduce((s, d) => s + d.hours, 0);
    const firstDay = days[0]?.date;
    const period = firstDay ? periodFor(firstDay) : null;
    await logEvent({
      companyId,
      action: 'manual_hours',
      entity: sourceName,
      detail: {
        period: period ? `${period.start} → ${period.end}` : null,
        hours: +totalHours.toFixed(2),
        mode: 'daily',
        dropped_after_end: written.droppedAfterEnd,
      },
    });
    return { ok: true, data: { batchId, droppedAfterEnd: written.droppedAfterEnd } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Could not add hours.'),
    };
  }
}

/** Edit-total: rewrite period total onto first entry, zero the rest. */
export async function editContractorTotal(args: unknown): Promise<ActionResult> {
  const parsed = EditTotalSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const { companyId, sourceName, ids, hours, periodStart, periodEnd } = parsed.data;

  const guard = await authGuard(companyId);
  if (!guard.ok) return guard;

  try {
    const db = await createServerSupabase();

    // The ids arrive from an aggregated table that can span several periods in
    // "all unpaid" mode; writing the total onto the earliest of those would
    // move hours into a closed period and zero the current one. Re-read the
    // dates (company-scoped) instead of trusting the client's order.
    const found = await fetchEntryDates(db, companyId, ids);
    if (found.length !== ids.length) {
      return { ok: false, error: 'Some of those entries no longer exist — refresh and try again.' };
    }
    const outside = datesOutsidePeriod(found, periodStart, periodEnd);
    if (outside.length > 0) {
      return {
        ok: false,
        error: `Cannot edit — ${outside.join(', ')} falls outside ${periodStart} – ${periodEnd}. Open that period and edit it there.`,
      };
    }

    const ordered = [...found].sort(
      (a, b) => a.workDate.localeCompare(b.workDate) || a.id.localeCompare(b.id),
    );
    const updates = ordered.map((e, i) => ({
      id: e.id,
      trackedSeconds: i === 0 ? Math.round(hours * 3600) : 0,
    }));
    await updateTrackedSeconds(db, companyId, updates);
    await logEvent({
      companyId,
      action: 'manual_hours',
      entity: sourceName,
      detail: {
        period: `${periodStart} → ${periodEnd}`,
        hours: +hours.toFixed(2),
        mode: 'edit-total',
      },
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Edit failed.'),
    };
  }
}

// ─── CSV import ───────────────────────────────────────────────────────────────

/** Import a batch of parsed CSV rows (upsert or skip mode). */
export async function importCsvBatch(
  args: unknown,
): Promise<
  ActionResult<{ batchId: string; written: number; skipped: number; droppedAfterEnd: number }>
> {
  const parsed = CsvImportSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const { companyId, rows, mode } = parsed.data;

  const guard = await authGuard(companyId);
  if (!guard.ok) return guard;

  const batchId = crypto.randomUUID();
  try {
    const db = await createServerSupabase();

    // Re-derive the name→worker mapping from the roster and re-key each row onto
    // the source_name that worker's existing rows already use — never trust the
    // client's mapping (RP-46), and never let a Hubstaff rename open a second
    // set of rows for days that are already paid-or-pending (RP-38).
    const roster = await fetchRosterLinks(db, companyId);
    const idx = buildMatchIndex(roster);
    const workerByName = new Map<string, string>();
    for (const name of new Set(rows.map((r) => r.sourceName))) {
      const workerId = matchName(name, idx)?.workerId;
      if (workerId) workerByName.set(name, workerId);
    }
    const canonical = await fetchCanonicalSourceNames(
      db,
      [companyId],
      [...new Set(workerByName.values())],
    );
    const resolved = new Map(
      [...workerByName].map(([name, workerId]) => [
        name,
        { workerId, sourceName: resolveSourceName(companyId, workerId, name, canonical) },
      ]),
    );
    const csvRows = canonicalizeCsvRows(rows, resolved);

    const datesSorted = csvRows.map((r) => r.workDate).sort();
    const dateMin = datesSorted[0];
    const dateMax = datesSorted[datesSorted.length - 1];
    if (!dateMin || !dateMax) {
      return { ok: false, error: 'No valid dates in import rows.' };
    }
    const sourceNames = [...new Set(csvRows.map((r) => r.sourceName))];

    // Read the window in BOTH modes: skip mode drops keys that already exist,
    // and either mode must leave a decided day alone.
    const existing = await fetchExistingDays(db, companyId, sourceNames, dateMin, dateMax);
    const toWrite = csvRowsToWrite(csvRows, existing, mode);
    const skipped = csvRows.length - toWrite.length;
    if (toWrite.length === 0) {
      // Not an error — there was simply nothing new to write. ok:true with
      // written:0 so the client renders this as a neutral no-op, not a
      // red error toast.
      return {
        ok: true,
        data: { batchId, written: 0, skipped, droppedAfterEnd: 0 },
        message: 'Nothing new to import — those rows already exist or are already decided.',
      };
    }

    // A Hubstaff CSV has no PTO column, so carry whatever the API sync stored
    // for the day rather than zeroing it on overwrite.
    const ptoByDay = new Map(existing.map((e) => [`${e.sourceName}|${e.workDate}`, e.ptoSeconds]));
    // Days after a contractor's last day are dropped by the writer, not here.
    const droppedAfterEnd = await upsertTimeEntries(
      db,
      toWrite.map((r) => ({
        company_id: companyId,
        worker_id: r.workerId,
        source_name: r.sourceName,
        work_date: r.workDate,
        tracked_seconds: r.trackedSeconds,
        pto_seconds: ptoByDay.get(`${r.sourceName}|${r.workDate}`) ?? 0,
        approval: 'pending',
        import_batch_id: batchId,
        activity_pct: r.activityPct,
      })),
    );

    const written = toWrite.length - droppedAfterEnd;
    const dates = [...new Set(toWrite.map((r) => r.workDate))].sort();
    const contractors = new Set(toWrite.map((r) => r.sourceName)).size;
    await logEvent({
      companyId,
      action: 'manual_hours',
      entity: `${dates[0] ?? ''} → ${dates[dates.length - 1] ?? ''}`,
      detail: {
        contractors,
        rows: written,
        dropped_after_end: droppedAfterEnd,
        mode,
        batch: batchId,
      },
    });

    return { ok: true, data: { batchId, written, skipped, droppedAfterEnd } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Import failed.'),
    };
  }
}

// ─── Batch delete ─────────────────────────────────────────────────────────────

/** Delete all entries in an import batch. Blocked if any entry's date falls
 *  inside a locked/paid pay_period. Cleans up empty open period drafts. */
export async function deleteImportBatch(args: unknown): Promise<ActionResult<{ deleted: number }>> {
  const parsed = DeleteBatchSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const { companyId, batchId } = parsed.data;

  const guard = await authGuard(companyId);
  if (!guard.ok) return guard;

  try {
    const db = await createServerSupabase();

    // Fetch date range of this batch to check for locked periods.
    const { data: batchEntries } = await db
      .from('time_entries')
      .select('work_date')
      .eq('company_id', companyId)
      .eq('import_batch_id', batchId);

    if (!batchEntries?.length) {
      return { ok: false, error: 'Batch not found or already deleted.' };
    }

    const dates = batchEntries.map((e) => e.work_date).sort();
    const dateMin = dates[0] ?? '';
    const dateMax = dates[dates.length - 1] ?? '';

    // Lock check.
    const locked = await fetchLockedPeriodsInRange(db, companyId, dateMin, dateMax);
    if (locked.length > 0) {
      const labels = locked.map((p) => `${p.periodStart}→${p.periodEnd} (${p.state})`).join(', ');
      return {
        ok: false,
        error: `Cannot delete — entries fall inside a saved/locked pay period: ${labels}. Unlock it first.`,
      };
    }

    const deleted = await deleteByBatch(db, companyId, batchId);

    // Clean up empty open draft periods.
    await deleteEmptyOpenPeriods(db, companyId, dateMin, dateMax);

    await logEvent({
      companyId,
      action: 'delete_import',
      entity: `batch:${batchId}`,
      detail: {
        batch: batchId,
        deleted,
        date_range: `${dateMin} → ${dateMax}`,
      },
    });

    return { ok: true, data: { deleted } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Delete failed.'),
    };
  }
}
