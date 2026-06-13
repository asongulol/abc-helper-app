'use server';

/**
 * Time server actions — verify admin → Zod validate → query module → audit log.
 * No inline SQL. No money math. Legacy audit action names preserved:
 *   'manual_hours', 'approve_time', 'delete_import'
 */

import { createServerSupabase } from '@/db/clients/server';
import {
  deleteByBatch,
  deleteEmptyOpenPeriods,
  fetchLockedPeriodsInRange,
  updateApproval,
  updateTrackedSeconds,
  upsertTimeEntries,
} from '@/db/queries/time';
import { periodFor } from '@/lib/dates/periods';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import {
  AddHoursDailySchema,
  AddHoursTotalSchema,
  CsvImportSchema,
  DeleteBatchSchema,
  EditTotalSchema,
  SetApprovalSchema,
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

// ─── Approval ────────────────────────────────────────────────────────────────

/** Approve or reject a set of time entries. */
export async function setTimeApproval(args: unknown): Promise<ActionResult<{ count: number }>> {
  const parsed = SetApprovalSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { companyId, ids, status } = parsed.data;

  const guard = await authGuard(companyId);
  if (!guard.ok) return guard;

  try {
    const db = await createServerSupabase();
    await updateApproval(db, ids, status);
    await logEvent({
      companyId,
      action: 'approve_time',
      entity: companyId,
      detail: { ids_count: ids.length, status },
    });
    return { ok: true, data: { count: ids.length } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Approval update failed.' };
  }
}

// ─── Manual hours ─────────────────────────────────────────────────────────────

/** Add total hours for a contractor (total mode → first day of period only). */
export async function addHoursTotal(args: unknown): Promise<ActionResult<{ batchId: string }>> {
  const parsed = AddHoursTotalSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { companyId, workerId, sourceName, periodStart, hours } = parsed.data;

  const guard = await authGuard(companyId);
  if (!guard.ok) return guard;

  const batchId = crypto.randomUUID();
  try {
    const db = await createServerSupabase();
    await upsertTimeEntries(db, [
      {
        company_id: companyId,
        worker_id: workerId,
        source_name: sourceName,
        work_date: periodStart,
        tracked_seconds: Math.round(hours * 3600),
        pto_seconds: 0,
        approval: 'pending',
        import_batch_id: batchId,
        activity_pct: null,
      },
    ]);
    const period = periodFor(periodStart);
    await logEvent({
      companyId,
      action: 'manual_hours',
      entity: sourceName,
      detail: {
        period: `${period.start} → ${period.end}`,
        hours: +hours.toFixed(2),
        mode: 'total',
      },
    });
    return { ok: true, data: { batchId } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not add hours.' };
  }
}

/** Add daily hours for a contractor (only days with hours > 0). */
export async function addHoursDaily(args: unknown): Promise<ActionResult<{ batchId: string }>> {
  const parsed = AddHoursDailySchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { companyId, workerId, sourceName, days } = parsed.data;

  const guard = await authGuard(companyId);
  if (!guard.ok) return guard;

  const batchId = crypto.randomUUID();
  try {
    const db = await createServerSupabase();
    await upsertTimeEntries(
      db,
      days.map((d) => ({
        company_id: companyId,
        worker_id: workerId,
        source_name: sourceName,
        work_date: d.date,
        tracked_seconds: Math.round(d.hours * 3600),
        pto_seconds: 0,
        approval: 'pending',
        import_batch_id: batchId,
        activity_pct: null,
      })),
    );
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
      },
    });
    return { ok: true, data: { batchId } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not add hours.' };
  }
}

/** Edit-total: rewrite period total onto first entry, zero the rest. */
export async function editContractorTotal(args: unknown): Promise<ActionResult> {
  const parsed = EditTotalSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { companyId, sourceName, ids, hours, periodStart, periodEnd } = parsed.data;

  const guard = await authGuard(companyId);
  if (!guard.ok) return guard;

  try {
    const db = await createServerSupabase();
    const updates = ids.map((id, i) => ({
      id,
      trackedSeconds: i === 0 ? Math.round(hours * 3600) : 0,
    }));
    await updateTrackedSeconds(db, updates);
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
    return { ok: false, error: err instanceof Error ? err.message : 'Edit failed.' };
  }
}

// ─── CSV import ───────────────────────────────────────────────────────────────

/** Import a batch of parsed CSV rows (upsert or skip mode). */
export async function importCsvBatch(
  args: unknown,
): Promise<ActionResult<{ batchId: string; written: number; skipped: number }>> {
  const parsed = CsvImportSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { companyId, rows, mode } = parsed.data;

  const guard = await authGuard(companyId);
  if (!guard.ok) return guard;

  const batchId = crypto.randomUUID();
  try {
    const db = await createServerSupabase();

    let toWrite = rows;
    let skipped = 0;

    if (mode === 'skip') {
      // Fetch existing (source_name, work_date) pairs in the date range.
      const datesSorted = rows.map((r) => r.workDate).sort();
      const dateMin = datesSorted[0];
      const dateMax = datesSorted[datesSorted.length - 1];
      if (!dateMin || !dateMax) {
        return { ok: false, error: 'No valid dates in import rows.' };
      }
      const sourceNames = [...new Set(rows.map((r) => r.sourceName))];
      const { data: existing } = await db
        .from('time_entries')
        .select('source_name, work_date')
        .eq('company_id', companyId)
        .gte('work_date', dateMin)
        .lte('work_date', dateMax)
        .in('source_name', sourceNames);
      const existKeys = new Set((existing ?? []).map((e) => `${e.source_name}|${e.work_date}`));
      toWrite = rows.filter((r) => !existKeys.has(`${r.sourceName}|${r.workDate}`));
      skipped = rows.length - toWrite.length;
      if (toWrite.length === 0) {
        return {
          ok: false,
          error: 'All rows already exist — nothing new to import.',
        };
      }
    }

    await upsertTimeEntries(
      db,
      toWrite.map((r) => ({
        company_id: companyId,
        worker_id: r.workerId,
        source_name: r.sourceName,
        work_date: r.workDate,
        tracked_seconds: r.trackedSeconds,
        pto_seconds: 0,
        approval: 'pending',
        import_batch_id: batchId,
        activity_pct: r.activityPct,
      })),
    );

    const dates = [...new Set(toWrite.map((r) => r.workDate))].sort();
    const contractors = new Set(toWrite.map((r) => r.sourceName)).size;
    await logEvent({
      companyId,
      action: 'manual_hours',
      entity: `${dates[0] ?? ''} → ${dates[dates.length - 1] ?? ''}`,
      detail: {
        contractors,
        rows: toWrite.length,
        mode,
        batch: batchId,
      },
    });

    return { ok: true, data: { batchId, written: toWrite.length, skipped } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Import failed.' };
  }
}

// ─── Batch delete ─────────────────────────────────────────────────────────────

/** Delete all entries in an import batch. Blocked if any entry's date falls
 *  inside a locked/paid pay_period. Cleans up empty open period drafts. */
export async function deleteImportBatch(args: unknown): Promise<ActionResult<{ deleted: number }>> {
  const parsed = DeleteBatchSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
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
      detail: { batch: batchId, deleted, date_range: `${dateMin} → ${dateMax}` },
    });

    return { ok: true, data: { deleted } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Delete failed.',
    };
  }
}
