'use server';

/**
 * Hubstaff "Option B" server actions — direct API sync from the Time Import
 * screen. Verify admin → Zod validate → Hubstaff API / service → audit log.
 *
 * Ports the legacy `hubstaff-sync` Edge Function flow (app/index.html ~4573):
 *   - `list_orgs`   → listHubstaffOrgs()  (populates the Organization dropdown)
 *   - default sync  → importHubstaffTime() (per-member daily totals → pending)
 *
 * The pull/transform/upsert orchestration is delegated to the existing
 * read-only service (syncHubstaffForCompany). The org-list fetch reuses the
 * read-only client helpers (getAccessToken / pageAll). Neither read-only file
 * is modified.
 */

import { z } from 'zod';
import { createServiceClient } from '@/db/clients/service';
import { fetchHubstaffOrgId } from '@/db/queries/hubstaff';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getAccessToken, HUBSTAFF_API_BASE, pageAll } from '@/server/hubstaff/client';
import { syncHubstaffForCompany } from '@/server/hubstaff/service';
import { uuid } from '@/types/schemas/uuid';

// ─── list orgs ─────────────────────────────────────────────────────────────────

/** A Hubstaff organization the connected token can see. */
export interface HubstaffOrg {
  id: number;
  name: string;
}

export interface ListHubstaffOrgsResult {
  organizations: HubstaffOrg[];
}

/**
 * List the Hubstaff organizations visible to the connected token.
 *
 * Mirrors the legacy edge fn `action: "list_orgs"` response shape
 * (`{ organizations: [{ id, name }] }`). Any signed-in admin may list orgs.
 */
export async function listHubstaffOrgs(): Promise<ActionResult<ListHubstaffOrgsResult>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  try {
    const token = await getAccessToken();
    const raw = await pageAll<{ id?: number; name?: string | null }>(
      `${HUBSTAFF_API_BASE}/organizations`,
      token,
      'organizations',
    );
    const organizations: HubstaffOrg[] = raw
      .filter((o): o is { id: number; name?: string | null } => o.id != null)
      .map((o) => ({ id: o.id, name: o.name ?? `org ${o.id}` }));

    return { ok: true, data: { organizations } };
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown error';
    return {
      ok: false,
      error: `Couldn't list orgs: ${detail} — is the hubstaff-sync function deployed and HUBSTAFF_REFRESH_TOKEN set?`,
    };
  }
}

/**
 * The org the sync will ACTUALLY use for this company (companies.hubstaff_org_id
 * — Aaron Anderson E.H.S. LLC on this deployment). Used to pre-select the
 * Organization picker so the admin doesn't have to list + pick an org whose
 * value the sync ignores anyway.
 *
 * ponytail: returns the bare id (null on any failure) — it's a prefill, an
 * error banner for it would be noise.
 */
export async function getDefaultHubstaffOrgId(companyId: unknown): Promise<number | null> {
  const parsed = uuid('companyId must be a UUID').safeParse(companyId);
  if (!parsed.success) return null;

  const admin = await getCurrentAdmin();
  if (!admin) return null;
  if (!admin.isOwner && !admin.companyIds.includes(parsed.data)) return null;

  try {
    return await fetchHubstaffOrgId(createServiceClient(), parsed.data);
  } catch {
    return null;
  }
}

// ─── import time ────────────────────────────────────────────────────────────────

const ImportHubstaffTimeSchema = z.object({
  companyId: uuid('companyId must be a UUID'),
  orgId: z.coerce.number().int().positive('orgId must be a positive integer'),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'start must be YYYY-MM-DD'),
  stop: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'stop must be YYYY-MM-DD'),
});

type ImportHubstaffTimeInput = z.infer<typeof ImportHubstaffTimeSchema>;

export interface ImportHubstaffTimeResult {
  rowsWritten: number;
  membersSeen: number;
  unmatched: string[];
  /** Approved days whose Hubstaff number changed — protected, and the admin is
   *  told. Dropping these here is what made the sync report "0 entries" while
   *  silently sitting on a 4h → 8h divergence (RP-36). */
  divergences: number;
  /** Decided day-rows the sync refused to overwrite. */
  skippedDecided: number;
  /** Days dropped for falling after a contractor's last day. */
  droppedAfterEnd: number;
  window: { start: string; stop: string };
}

/**
 * Pull per-member daily totals from Hubstaff for the selected org + window and
 * stage them as pending time entries (legacy Option B default sync).
 *
 * Requires admin access to the company. The org is configured on the company
 * (companies.hubstaff_org_id); the selected `orgId` is recorded in the audit
 * log for traceability.
 */
export async function importHubstaffTime(
  args: unknown,
): Promise<ActionResult<ImportHubstaffTimeResult>> {
  const parsed = ImportHubstaffTimeSchema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }
  const { companyId, orgId, start, stop }: ImportHubstaffTimeInput = parsed.data;

  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = createServiceClient();
    const summary = await syncHubstaffForCompany(db, companyId, {
      start,
      stop,
    });

    await logEvent({
      companyId,
      action: 'import',
      entity: 'Hubstaff API sync',
      detail: {
        org_id: orgId,
        window: `${summary.window.start} → ${summary.window.stop}`,
        rows_written: summary.rowsWritten,
        members_seen: summary.membersSeen,
        dropped_after_end: summary.droppedAfterEnd,
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
        divergences: summary.divergences.length,
        skippedDecided: summary.skippedDecided,
        droppedAfterEnd: summary.droppedAfterEnd,
        window: summary.window,
      },
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown error';
    return {
      ok: false,
      error: `Sync failed: ${detail} — check the hubstaff-sync Edge Function is deployed and its token is set.`,
    };
  }
}
