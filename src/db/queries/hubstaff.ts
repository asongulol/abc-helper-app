/**
 * Hubstaff sync DB reads.
 *
 * Callers pass an already-created Supabase client (ADR-0002/0003 — no inline
 * queries in actions/routes). The service layer always uses the service client
 * because resolving employer org ids and persisting hubstaff_user_id require
 * service-role access.
 *
 * Time-entries upserts delegate to upsertTimeEntries from db/queries/time.ts
 * (same conflict key: company_id,source_name,work_date).
 */

import 'server-only';
import type { Database } from '@/db/types';
import type { ExistingDecidedEntry, WorkerLink } from '@/lib/hubstaff/types';
import type { SupabaseClient } from '@supabase/supabase-js';

type Db = SupabaseClient<Database>;

// ─── Company / org resolution ─────────────────────────────────────────────────

/**
 * Fetch the Hubstaff org id for a company, or null when not configured.
 * Used by the service to know which Hubstaff org to pull activities for.
 */
export const fetchHubstaffOrgId = async (db: Db, companyId: string): Promise<number | null> => {
  const { data, error } = await db
    .from('companies')
    .select('hubstaff_org_id')
    .eq('id', companyId)
    .maybeSingle();
  if (error) throw new Error(`companies (hubstaff_org_id): ${error.message}`);
  return data?.hubstaff_org_id ?? null;
};

// ─── Worker-companies / match index ──────────────────────────────────────────

/**
 * Fetch ALL worker_companies links (employer-wide, not scoped to one company)
 * for building the name-match index.
 *
 * The legacy fn fetches employer-wide because a contractor may be assigned to
 * any client; matching is done at the employer level and time always lands on
 * the employer company (targetCompanyId in the transform).
 */
export const fetchAllWorkerLinks = async (db: Db): Promise<WorkerLink[]> => {
  const { data, error } = await db
    .from('worker_companies')
    .select(
      'company_id,worker_id,hubstaff_name,hubstaff_user_id,status,workers(first_name,last_name,status)',
    );
  if (error) throw new Error(`worker_companies (all links): ${error.message}`);

  return (data ?? []).map((l) => {
    const w = l.workers;
    const linkInactive = l.status === 'ended';
    const workerInactive = w?.status === 'ended';
    return {
      workerId: l.worker_id,
      companyId: l.company_id,
      hubstaffUserId: l.hubstaff_user_id ?? null,
      hubstaffName: l.hubstaff_name ?? null,
      workerFirstName: w?.first_name ?? null,
      workerLastName: w?.last_name ?? null,
      isInactive: linkInactive || workerInactive,
    };
  });
};

// ─── Canonical source_name lookup ────────────────────────────────────────────

/**
 * Fetch the most-recent source_name per (company_id, worker_id) for the given
 * company ids, so the upsert hits the same unique key as prior rows.
 *
 * Returns a Map keyed by "companyId|workerId".
 */
export const fetchCanonicalSourceNames = async (
  db: Db,
  companyIds: string[],
  workerIds: string[],
): Promise<Map<string, string>> => {
  if (companyIds.length === 0 || workerIds.length === 0) return new Map();

  const { data, error } = await db
    .from('time_entries')
    .select('company_id,worker_id,source_name,work_date')
    .in('company_id', companyIds)
    .in('worker_id', workerIds)
    .order('work_date', { ascending: false });

  if (error) throw new Error(`time_entries (canonical source_name): ${error.message}`);

  const canonical = new Map<string, string>();
  for (const row of data ?? []) {
    if (!row.worker_id) continue;
    const k = `${row.company_id}|${row.worker_id}`;
    if (!canonical.has(k)) canonical.set(k, row.source_name);
  }
  return canonical;
};

// ─── Decided-entry guard ──────────────────────────────────────────────────────

/**
 * Fetch existing time_entries in the sync window so the transform can skip any
 * rows a human has already approved or rejected (approval !== 'pending').
 */
export const fetchExistingDecided = async (
  db: Db,
  companyIds: string[],
  start: string,
  stop: string,
): Promise<ExistingDecidedEntry[]> => {
  if (companyIds.length === 0) return [];

  const { data, error } = await db
    .from('time_entries')
    .select('company_id,worker_id,source_name,work_date,approval')
    .in('company_id', companyIds)
    .gte('work_date', start)
    .lte('work_date', stop);

  if (error) throw new Error(`time_entries (decided guard): ${error.message}`);
  return (data ?? []).map((r) => ({
    company_id: r.company_id,
    worker_id: r.worker_id ?? null,
    source_name: r.source_name,
    work_date: r.work_date,
    approval: r.approval,
  }));
};

// ─── Persist stable hubstaff_user_id ─────────────────────────────────────────

/**
 * Write the Hubstaff numeric user_id back to a worker_companies link that
 * previously matched by name. On the next sync run the id-first match fires
 * immediately, skipping the name-resolution step.
 *
 * Only patches rows where hubstaff_user_id IS NULL (safe to call idempotently).
 */
export const persistHubstaffUserId = async (
  db: Db,
  companyId: string,
  workerId: string,
  hubstaffUserId: number,
): Promise<void> => {
  const { error } = await db
    .from('worker_companies')
    .update({ hubstaff_user_id: hubstaffUserId })
    .eq('company_id', companyId)
    .eq('worker_id', workerId)
    .is('hubstaff_user_id', null);
  if (error) {
    throw new Error(`worker_companies (persist hubstaff_user_id): ${error.message}`);
  }
};
