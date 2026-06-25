'use server';

/**
 * Bulk contractor import (legacy "Bulk import contractors", manifest 20).
 * Admin + company-scoped. Existing contractors are matched by Wise recipient id
 * first, then by normalized full name, and updated in place; the rest are
 * created and linked to the company. Service client after the role check
 * (ADR-0004).
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin, requireAdmin } from '@/server/auth/admin';
import { serviceGetRecipient } from '@/server/wise/service';
import { uuid } from '@/types/schemas/uuid';

export type ImportActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

const fail = (e: unknown): { ok: false; error: string } => ({
  ok: false,
  error: e instanceof Error ? e.message : String(e ?? 'Unknown error'),
});

const RowSchema = z.object({
  firstName: z.string().trim().min(1, 'First name required'),
  lastName: z.string().trim().default(''),
  email: z.string().trim().optional(),
  ratePhp: z.number().nonnegative().optional(),
  wiseRecipientId: z.number().int().positive().optional(),
  wiseUuid: z.string().trim().optional(),
  hubstaffName: z.string().trim().optional(),
});

const InputSchema = z.object({
  companyId: uuid(),
  /** When true, prefer the Wise account name (fetched per recipient id). */
  preferWiseName: z.boolean().optional().default(false),
  rows: z.array(RowSchema).min(1, 'No rows to import').max(1000, 'Too many rows (max 1000)'),
});

export type ImportRow = z.input<typeof RowSchema>;

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export async function importContractors(
  args: unknown,
): Promise<ImportActionResult<{ created: number; updated: number; errors: string[] }>> {
  try {
    const admin = await requireAdmin();
    const parsed = InputSchema.safeParse(args);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');
    const { companyId, preferWiseName, rows } = parsed.data;
    if (!admin.isOwner && !admin.companyIds.includes(companyId))
      return fail('No access to this company.');

    const db = createServiceClient();

    // Index the company's roster by Wise id, Wise UUID, Hubstaff name, and name.
    const { data: links } = await db
      .from('worker_companies')
      .select(
        'worker_id, hubstaff_name, workers(id, first_name, middle_name, last_name, wise_recipient_id, wise_recipient_uuid)',
      )
      .eq('company_id', companyId);

    const byWise = new Map<number, string>();
    const byUuid = new Map<string, string>();
    const byHubstaff = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const l of links ?? []) {
      const w = l.workers;
      if (!w) continue;
      if (w.wise_recipient_id != null) byWise.set(w.wise_recipient_id, w.id);
      if (w.wise_recipient_uuid) byUuid.set(w.wise_recipient_uuid, w.id);
      if (l.hubstaff_name) byHubstaff.set(norm(l.hubstaff_name), w.id);
      byName.set(norm([w.first_name, w.middle_name, w.last_name].filter(Boolean).join(' ')), w.id);
    }

    const today = new Date().toISOString().slice(0, 10);
    let created = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const r of rows) {
      const label = `${r.firstName} ${r.lastName}`.trim();
      try {
        // Optionally prefer the Wise account name so the DB name matches payouts.
        let firstName = r.firstName;
        let lastName = r.lastName;
        if (preferWiseName && r.wiseRecipientId != null) {
          try {
            const rec = (await serviceGetRecipient(r.wiseRecipientId)) as {
              name?: string;
            } | null;
            const nm = (rec?.name ?? '').trim();
            if (nm) {
              const parts = nm.split(/\s+/);
              firstName = parts[0] ?? firstName;
              lastName = parts.slice(1).join(' ') || lastName;
            }
          } catch {
            /* best-effort — fall back to the sheet name */
          }
        }

        // Match by Wise recipient id → Wise UUID → Hubstaff name → normalized name.
        let workerId: string | null = null;
        if (r.wiseRecipientId != null && byWise.has(r.wiseRecipientId))
          workerId = byWise.get(r.wiseRecipientId) ?? null;
        if (!workerId && r.wiseUuid && byUuid.has(r.wiseUuid))
          workerId = byUuid.get(r.wiseUuid) ?? null;
        if (!workerId && r.hubstaffName && byHubstaff.has(norm(r.hubstaffName)))
          workerId = byHubstaff.get(norm(r.hubstaffName)) ?? null;
        if (!workerId) {
          const key = norm(`${firstName} ${lastName}`.trim());
          if (byName.has(key)) workerId = byName.get(key) ?? null;
        }

        if (workerId) {
          const patch: {
            email?: string;
            wise_recipient_id?: number;
            wise_recipient_uuid?: string;
          } = {};
          if (r.email) patch.email = r.email;
          if (r.wiseRecipientId != null) patch.wise_recipient_id = r.wiseRecipientId;
          if (r.wiseUuid) patch.wise_recipient_uuid = r.wiseUuid;
          if (Object.keys(patch).length > 0) {
            await db.from('workers').update(patch).eq('id', workerId);
          }
          if (r.hubstaffName) {
            await db
              .from('worker_companies')
              .update({ hubstaff_name: r.hubstaffName })
              .eq('worker_id', workerId)
              .eq('company_id', companyId);
          }
          updated++;
          continue;
        }

        // Create a new worker + company link.
        const { data: w, error: wErr } = await db
          .from('workers')
          .insert({
            first_name: firstName,
            last_name: lastName,
            status: 'active',
            health_allowance_eligible: true,
            thirteenth_month_eligible: true,
            ...(r.email ? { email: r.email } : {}),
            ...(r.wiseRecipientId != null ? { wise_recipient_id: r.wiseRecipientId } : {}),
            ...(r.wiseUuid ? { wise_recipient_uuid: r.wiseUuid } : {}),
          })
          .select('id')
          .single();
        if (wErr || !w) {
          errors.push(`${label}: ${wErr?.message ?? 'insert failed'}`);
          continue;
        }
        const { error: lErr } = await db.from('worker_companies').insert({
          worker_id: w.id,
          company_id: companyId,
          contract: 'FT',
          status: 'active',
          ...(r.hubstaffName ? { hubstaff_name: r.hubstaffName } : {}),
        });
        if (lErr) {
          await db.from('workers').delete().eq('id', w.id); // orphan cleanup
          errors.push(`${label}: ${lErr.message}`);
          continue;
        }
        if (r.ratePhp != null && r.ratePhp > 0) {
          await db.from('rates').insert({
            worker_id: w.id,
            company_id: companyId,
            amount_php: r.ratePhp,
            period_basis: 'semi_monthly',
            effective_start: today,
          });
        }
        byName.set(norm(`${firstName} ${lastName}`.trim()), w.id);
        if (r.wiseRecipientId != null) byWise.set(r.wiseRecipientId, w.id);
        if (r.wiseUuid) byUuid.set(r.wiseUuid, w.id);
        if (r.hubstaffName) byHubstaff.set(norm(r.hubstaffName), w.id);
        created++;
      } catch (e) {
        errors.push(`${label}: ${e instanceof Error ? e.message : 'failed'}`);
      }
    }

    await logEvent({
      action: 'contractors.bulk_import',
      entity: companyId,
      detail: { created, updated, errors: errors.length, by: admin.email },
    });
    revalidatePath('/contractors');
    return { ok: true, data: { created, updated, errors } };
  } catch (e) {
    return fail(e);
  }
}

// ─── Delete imports (legacy DeleteImports, manifest "Imports" tab) ────────────

/** Admin + company-scope guard shared by the delete-imports actions. */
const deleteGuard = async (
  companyId: string,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(companyId))
    return { ok: false, error: 'No access to this company.' };
  return { ok: true };
};

const RangeSchema = z.object({
  companyId: uuid(),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid From date.'),
  stop: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid To date.'),
});

export interface ImportBatchGroup {
  /** import_batch_id, or null for legacy/manual rows with no batch id. */
  id: string | null;
  rows: number;
  /** earliest work_date in the batch (ISO yyyy-mm-dd). */
  min: string;
  /** latest work_date in the batch (ISO yyyy-mm-dd). */
  max: string;
  /** created_at of the first row seen (ISO timestamp) for the "Imported" column. */
  when: string | null;
}

export interface RangeDeletePreviewRow {
  name: string;
  rows: number;
  hours: number;
  firstDate: string;
  lastDate: string;
}

export interface RangeOverlapPeriod {
  periodStart: string;
  periodEnd: string;
  state: string;
}

export interface RangeDryRun {
  count: number;
  preview: RangeDeletePreviewRow[];
  overlap: RangeOverlapPeriod[];
}

/**
 * Recent import batches for this company, grouped from time_entries by
 * import_batch_id (mirrors legacy DeleteImports grouping). Newest first,
 * capped at 12 batches scanned from the most recent 2000 rows.
 */
export async function fetchImportBatchGroups(
  companyId: string,
): Promise<ImportActionResult<ImportBatchGroup[]>> {
  try {
    const guard = await deleteGuard(companyId);
    if (!guard.ok) return guard;

    const db = await createServerSupabase();
    const { data, error } = await db
      .from('time_entries')
      .select('import_batch_id, work_date, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error) return fail(error.message);

    const batches = new Map<string, ImportBatchGroup>();
    for (const r of data ?? []) {
      const key = r.import_batch_id ?? '(no batch)';
      const g = batches.get(key);
      if (g) {
        g.rows++;
        if (r.work_date < g.min) g.min = r.work_date;
        if (r.work_date > g.max) g.max = r.work_date;
      } else {
        batches.set(key, {
          id: r.import_batch_id ?? null,
          rows: 1,
          min: r.work_date,
          max: r.work_date,
          when: r.created_at ?? null,
        });
      }
    }
    return { ok: true, data: [...batches.values()].slice(0, 12) };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Dry-run the date-range delete: count rows, build a per-contractor preview
 * (rows / hours / date span), and detect any locked/paid pay periods the
 * window overlaps. No mutation. Mirrors legacy armRange.
 */
export async function dryRunDeleteRange(args: unknown): Promise<ImportActionResult<RangeDryRun>> {
  try {
    const parsed = RangeSchema.safeParse(args);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input.');
    const { companyId, start, stop } = parsed.data;
    if (start > stop) return fail("'From' must be on or before 'To'.");

    const guard = await deleteGuard(companyId);
    if (!guard.ok) return guard;

    const db = await createServerSupabase();

    const { data: rows, error } = await db
      .from('time_entries')
      .select('source_name, work_date, tracked_seconds, pto_seconds')
      .eq('company_id', companyId)
      .gte('work_date', start)
      .lte('work_date', stop);
    if (error) return fail(error.message);

    const count = (rows ?? []).length;

    const byName = new Map<
      string,
      {
        name: string;
        rows: number;
        firstDate: string;
        lastDate: string;
        sec: number;
      }
    >();
    for (const r of rows ?? []) {
      const name = r.source_name ?? '';
      const g = byName.get(name);
      const sec = Number(r.tracked_seconds ?? 0) + Number(r.pto_seconds ?? 0);
      if (g) {
        g.rows++;
        g.sec += sec;
        if (r.work_date < g.firstDate) g.firstDate = r.work_date;
        if (r.work_date > g.lastDate) g.lastDate = r.work_date;
      } else {
        byName.set(name, {
          name,
          rows: 1,
          firstDate: r.work_date,
          lastDate: r.work_date,
          sec,
        });
      }
    }
    const preview: RangeDeletePreviewRow[] = [...byName.values()]
      .map((g) => ({
        name: g.name,
        rows: g.rows,
        hours: +(g.sec / 3600).toFixed(2),
        firstDate: g.firstDate,
        lastDate: g.lastDate,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const { data: pps } = await db
      .from('pay_periods')
      .select('period_start, period_end, state')
      .eq('company_id', companyId)
      .in('state', ['locked', 'paid'])
      .lte('period_start', stop)
      .gte('period_end', start);
    const overlap: RangeOverlapPeriod[] = (pps ?? [])
      .filter((p) => p.period_start <= stop && p.period_end >= start)
      .map((p) => ({
        periodStart: p.period_start,
        periodEnd: p.period_end,
        state: p.state,
      }));

    return { ok: true, data: { count, preview, overlap } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Delete all time entries for the company in [start, stop]. When the window
 * overlaps any locked/paid period the caller must pass confirmText === 'DELETE'
 * (the extra-friction path). Also clears payments for OPEN periods overlapping
 * the range so a calculated draft doesn't linger with no underlying hours.
 * Mirrors legacy doDeleteRange + clearOpenBatchPayments.
 */
export async function deleteImportRange(
  args: unknown,
): Promise<ImportActionResult<{ deleted: number; clearedBatches: number }>> {
  try {
    const parsed = RangeSchema.extend({
      confirmText: z.string().optional(),
    }).safeParse(args);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input.');
    const { companyId, start, stop, confirmText } = parsed.data;
    if (start > stop) return fail("'From' must be on or before 'To'.");

    const guard = await deleteGuard(companyId);
    if (!guard.ok) return guard;

    const db = await createServerSupabase();

    // Re-check overlap server-side; if the range overlaps locked/paid periods,
    // require the typed-DELETE confirmation.
    const { data: pps } = await db
      .from('pay_periods')
      .select('period_start, period_end, state')
      .eq('company_id', companyId)
      .in('state', ['locked', 'paid'])
      .lte('period_start', stop)
      .gte('period_end', start);
    const overlap = (pps ?? []).filter((p) => p.period_start <= stop && p.period_end >= start);
    if (overlap.length > 0 && confirmText !== 'DELETE') {
      return fail('Type DELETE to confirm — this range overlaps locked/paid period(s).');
    }

    const { error, count } = await db
      .from('time_entries')
      .delete({ count: 'exact' })
      .eq('company_id', companyId)
      .gte('work_date', start)
      .lte('work_date', stop);
    if (error) return fail(error.message);

    // Clear payments for OPEN periods overlapping the range.
    let clearedBatches = 0;
    const { data: openPps } = await db
      .from('pay_periods')
      .select('id, period_start, period_end')
      .eq('company_id', companyId)
      .eq('state', 'open')
      .lte('period_start', stop)
      .gte('period_end', start);
    const open = (openPps ?? []).filter((p) => p.period_start <= stop && p.period_end >= start);
    for (const p of open) {
      await db.from('payments').delete().eq('pay_period_id', p.id);
    }
    clearedBatches = open.length;

    await logEvent({
      companyId,
      action: 'delete_import',
      entity: `range:${start}→${stop}`,
      detail: {
        deleted: count ?? 0,
        date_range: `${start} → ${stop}`,
        cleared_batches: clearedBatches,
      },
    });

    revalidatePath('/imports');
    return { ok: true, data: { deleted: count ?? 0, clearedBatches } };
  } catch (e) {
    return fail(e);
  }
}
