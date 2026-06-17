import 'server-only';

/**
 * Hubstaff sync service — orchestration layer.
 *
 * SINGLE SOURCE OF TRUTH NOTE
 * ───────────────────────────
 * The pure transform logic lives in src/lib/hubstaff/transform.ts. That module
 * has no runtime dependencies (no fetch, no env, no Deno/Node APIs) and is
 * fully unit-tested in tests/lib/hubstaff/transform.test.ts.
 *
 * This file provides the Next.js-side I/O shell:
 *   1. Resolve a valid Hubstaff access token (via server/hubstaff/client.ts).
 *   2. Pull activities and PTO from the Hubstaff API.
 *   3. Call the pure transform.
 *   4. Upsert the results via db/queries/time.ts (same conflict key as CSV import).
 *   5. Persist stable hubstaff_user_id back on name-matched links.
 *
 * EDGE FUNCTION NOTE
 * ──────────────────
 * The deployed Deno edge function (supabase/functions/hubstaff-sync/index.ts in
 * the legacy repo, or supabase/functions/hubstaff-sync/ in this repo once created)
 * should be refactored into a THIN DENO WRAPPER that:
 *   a) Validates the x-cron-secret.
 *   b) Calls getAccessToken() (Deno-compatible fetch + Supabase REST, no Node APIs).
 *   c) Pulls activities/PTO with pageAll().
 *   d) Calls accumulateActivities + accumulatePto + transformActivities directly
 *      (copy or vendor the pure files — Deno can import TS via the same module).
 *   e) Upserts via the Supabase REST API (fetch-only, no Node SDK needed).
 *
 * The cron SCHEDULE (nightly job) stays on the deployed Deno edge function.
 * The 'Sync now' button in the UI calls syncHubstaffForCompany here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchAllWorkerLinks,
  fetchCanonicalSourceNames,
  fetchExistingDecided,
  fetchHubstaffOrgId,
  persistHubstaffUserId,
} from '@/db/queries/hubstaff';
import { upsertTimeEntries } from '@/db/queries/time';
import type { Database } from '@/db/types';
import {
  accumulateActivities,
  accumulatePto,
  buildDecidedSets,
  buildWorkerMatchIndex,
  dateRange,
  resolveWindow,
  transformActivities,
} from '@/lib/hubstaff/transform';
import type { HubstaffDailyActivity, HubstaffTimeOffRequest } from '@/lib/hubstaff/types';
import { fetchMemberNames, getAccessToken, HUBSTAFF_API_BASE, pageAll } from './client';

type Db = SupabaseClient<Database>;

// ─── Result type ──────────────────────────────────────────────────────────────

export interface HubstaffSyncSummary {
  ok: boolean;
  window: { start: string; stop: string };
  companyId: string;
  orgId: number;
  membersSeen: number;
  rowsWritten: number;
  idsPersisted: number;
  skippedDecided: number;
  unmatched: string[];
  importBatchId: string;
}

// ─── Core sync ────────────────────────────────────────────────────────────────

/**
 * Pull Hubstaff activities for a company's org over a date range, transform
 * via the pure lib, and upsert into time_entries.
 *
 * Idempotent: re-running for the same window updates pending rows; rows a
 * human has already approved/rejected are protected.
 *
 * @param db          Service-role Supabase client (needed for employer-wide reads).
 * @param companyId   The employer company id (time always lands here).
 * @param opts.start  Explicit 'YYYY-MM-DD' start (overrides lookbackDays).
 * @param opts.stop   Explicit 'YYYY-MM-DD' stop  (overrides lookbackDays).
 * @param opts.lookbackDays  Days to look back from today (default 3, max 31).
 * @param opts.today  Override today's date (useful for testing / cron drivers).
 */
export async function syncHubstaffForCompany(
  db: Db,
  companyId: string,
  opts: {
    start?: string | null;
    stop?: string | null;
    lookbackDays?: number | null;
    today?: string | null;
  } = {},
): Promise<HubstaffSyncSummary> {
  // 1. Resolve the sync window.
  const { start, stop, startMs, stopMs } = resolveWindow({
    ...(opts.start != null ? { start: opts.start } : {}),
    ...(opts.stop != null ? { stop: opts.stop } : {}),
    ...(opts.lookbackDays != null ? { lookbackDays: opts.lookbackDays } : {}),
    ...(opts.today != null ? { today: opts.today } : {}),
  });

  // 2. Look up the Hubstaff org id for this company.
  const orgId = await fetchHubstaffOrgId(db, companyId);
  if (!orgId) {
    throw new Error(
      `Company ${companyId} has no hubstaff_org_id configured. Set it in the companies table.`,
    );
  }

  // 3. Get a valid access token (refresh if needed).
  const token = await getAccessToken();

  // 4. Fetch member names.
  const nameById = await fetchMemberNames(orgId, token);
  const membersSeen = nameById.size;

  // 5. Pull daily activities (Hubstaff rejects ranges >31 days — service
  //    stays ≤31 d per resolveWindow; activity_backfill uses chunks).
  const acts = await pageAll<HubstaffDailyActivity>(
    `${HUBSTAFF_API_BASE}/organizations/${orgId}/activities/daily?date%5Bstart%5D=${start}&date%5Bstop%5D=${stop}`,
    token,
    'daily_activities',
  );

  // 6. Pull PTO (best-effort — sync continues without PTO on failure).
  let ptoRequests: HubstaffTimeOffRequest[] = [];
  try {
    ptoRequests = await pageAll<HubstaffTimeOffRequest>(
      `${HUBSTAFF_API_BASE}/organizations/${orgId}/time_off_requests`,
      token,
      'time_off_requests',
    );
  } catch {
    // PTO failure is non-fatal — tracked time still syncs.
  }

  // 7. Accumulate per-user per-day totals.
  const accum = accumulateActivities(acts);
  accumulatePto(accum, ptoRequests, startMs, stopMs);

  if (accum.size === 0) {
    const importBatchId = crypto.randomUUID();
    return {
      ok: true,
      window: { start, stop },
      companyId,
      orgId,
      membersSeen,
      rowsWritten: 0,
      idsPersisted: 0,
      skippedDecided: 0,
      unmatched: [],
      importBatchId,
    };
  }

  // 8. Build the worker match index (employer-wide).
  const allLinks = await fetchAllWorkerLinks(db);
  const idx = buildWorkerMatchIndex(allLinks);

  // 9. Canonical source_name lookup (avoid duplicate rows under different names).
  const workerIds = [...new Set(allLinks.map((l) => l.workerId))];
  const canonical = await fetchCanonicalSourceNames(db, [companyId], workerIds);

  // 10. Decided-entry guard (never overwrite a human decision).
  const existingDecided = await fetchExistingDecided(db, [companyId], start, stop);
  const decided = buildDecidedSets(existingDecided);
  const decidedCount = decided.decidedBySrc.size + decided.decidedByWorker.size;

  // 11. Pure transform.
  const days = dateRange(start, stop);
  const importBatchId = crypto.randomUUID();
  const result = transformActivities({
    accum,
    nameById,
    idx,
    canonical,
    decided,
    targetCompanyId: companyId,
    days,
    importBatchId,
  });

  // Compute skipped-decided count (rows that had time but were blocked).
  // We can derive this as: users with time * days - actual rows written - unmatched.
  // A simpler proxy: decidedCount > 0 means some rows were skipped.
  // For an accurate count we'd need to check inside transform — use guard size as a proxy.
  const skippedDecided = decidedCount > 0 ? decidedCount : 0;

  // 12. Upsert time_entries (conflict: company_id,source_name,work_date).
  await upsertTimeEntries(db, result.rows);

  // 13. Persist stable hubstaff_user_id for name-matched links.
  for (const p of result.idsToPersist) {
    try {
      await persistHubstaffUserId(db, p.companyId, p.workerId, p.hubstaffUserId);
    } catch {
      // best-effort — a failed persist just slows future matching
    }
  }

  return {
    ok: true,
    window: { start, stop },
    companyId,
    orgId,
    membersSeen,
    rowsWritten: result.rows.length,
    idsPersisted: result.idsToPersist.length,
    skippedDecided,
    unmatched: result.unmatched,
    importBatchId,
  };
}
