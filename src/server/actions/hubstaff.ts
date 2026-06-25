'use server';

/**
 * Hubstaff server actions — verify admin → Zod validate → service → audit log.
 * No inline SQL. Mirrors the pattern from src/server/actions/time.ts.
 *
 * syncHubstaffNow: manual 'Sync from Hubstaff' trigger for the Time Import
 * screen. The scheduled daily sync continues to run via the Deno edge function
 * (supabase/functions/hubstaff-sync/); this action covers on-demand admin runs.
 */

import { z } from 'zod';
import { createServiceClient } from '@/db/clients/service';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import { syncHubstaffForCompany } from '@/server/hubstaff/service';
import { uuid } from '@/types/schemas/uuid';

// ─── Input schema ─────────────────────────────────────────────────────────────

const SyncHubstaffSchema = z.object({
  companyId: uuid('companyId must be a UUID'),
  /** Explicit 'YYYY-MM-DD' start; omit to use the default lookback window. */
  periodStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'periodStart must be YYYY-MM-DD')
    .optional(),
  /** Explicit 'YYYY-MM-DD' stop; omit to use the default lookback window. */
  periodEnd: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'periodEnd must be YYYY-MM-DD')
    .optional(),
});

type SyncHubstaffInput = z.infer<typeof SyncHubstaffSchema>;

// ─── Action ───────────────────────────────────────────────────────────────────

export interface SyncHubstaffResult {
  rowsWritten: number;
  membersSeen: number;
  unmatched: string[];
  window: { start: string; stop: string };
  importBatchId: string;
}

/**
 * Manual 'Sync from Hubstaff' action.
 *
 * Requires admin access to the specified company. The service client is used
 * for the sync (employer-wide worker_companies read + time_entries upsert).
 */
export async function syncHubstaffNow(args: unknown): Promise<ActionResult<SyncHubstaffResult>> {
  const parsed = SyncHubstaffSchema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }
  const { companyId, periodStart, periodEnd }: SyncHubstaffInput = parsed.data;

  // Auth guard.
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = createServiceClient();
    const summary = await syncHubstaffForCompany(db, companyId, {
      ...(periodStart !== undefined ? { start: periodStart } : {}),
      ...(periodEnd !== undefined ? { stop: periodEnd } : {}),
    });

    await logEvent({
      companyId,
      action: 'hubstaff_sync',
      entity: companyId,
      detail: {
        window: `${summary.window.start} → ${summary.window.stop}`,
        rows_written: summary.rowsWritten,
        members_seen: summary.membersSeen,
        ids_persisted: summary.idsPersisted,
        unmatched: summary.unmatched,
        batch: summary.importBatchId,
      },
    });

    return {
      ok: true,
      data: {
        rowsWritten: summary.rowsWritten,
        membersSeen: summary.membersSeen,
        unmatched: summary.unmatched,
        window: summary.window,
        importBatchId: summary.importBatchId,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Hubstaff sync failed.',
    };
  }
}
