/**
 * contract_versions reads (docs/CONTRACT-VERSIONS-PLAN.md §2).
 *
 * Rows here start at version 2. Version 1 of every current engagement is the
 * existing onboarding_agreements.ic_agreement row + its doc_version='1'
 * signature, read through here as `source: 'legacy'` — no backfill, and the
 * legacy portal keeps rendering that row untouched.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';
import { DEFAULT_NOTICE_DAYS } from '@/lib/agreements/merge';

type Db = SupabaseClient<Database>;
type Row = Database['public']['Tables']['contract_versions']['Row'];

export type ContractVersionStatus = Database['public']['Enums']['contract_version_status'];

export type ContractTerms = {
  /** Semi-monthly PHP amount. Null only on a legacy read-through with no rate row yet. */
  ratePhp: number | null;
  periodBasis: string;
  position: string | null;
  employmentType: Database['public']['Enums']['contract_type'] | null;
  schedule: string | null;
  hoursPerWeek: number | null;
  startDate: string | null;
  effectiveFrom: string | null;
  addendumType: string | null;
  addendumText: string | null;
  /** Section 11.1 termination notice, calendar days — the {{notice_days}} token. */
  noticeDays: number;
};

export type ContractVersion = ContractTerms & {
  id: string;
  workerId: string;
  companyId: string;
  version: number;
  status: ContractVersionStatus;
  supersedesId: string | null;
  endedOn: string | null;
  renderedBody: string | null;
  docSha256: string | null;
  sentAt: string | null;
  signedAt: string | null;
  countersignedAt: string | null;
  countersignedBy: string | null;
  countersignedName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type ContractOfRecord = ContractTerms & {
  version: number;
  /** 'legacy' = the v1 read-through; no contract_versions row backs it. */
  source: 'legacy' | 'versioned';
  /** contract_versions.id, null for the legacy read-through. */
  id: string | null;
  signedAt: string | null;
  countersignedAt: string | null;
  countersignedName: string | null;
  docSha256: string | null;
};

const mapVersion = (r: Row): ContractVersion => ({
  id: r.id,
  workerId: r.worker_id,
  companyId: r.company_id,
  version: r.version,
  status: r.status,
  ratePhp: Number(r.rate_php),
  periodBasis: r.period_basis,
  position: r.position,
  employmentType: r.employment_type,
  schedule: r.schedule,
  hoursPerWeek: r.hours_per_week,
  startDate: r.start_date,
  effectiveFrom: r.effective_from,
  addendumType: r.addendum_type,
  addendumText: r.addendum_text,
  noticeDays: r.notice_days,
  supersedesId: r.supersedes_id,
  endedOn: r.ended_on,
  renderedBody: r.rendered_body,
  docSha256: r.doc_sha256,
  sentAt: r.sent_at,
  signedAt: r.signed_at,
  countersignedAt: r.countersigned_at,
  countersignedBy: r.countersigned_by,
  countersignedName: r.countersigned_name,
  voidedAt: r.voided_at,
  voidReason: r.void_reason,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

/**
 * Every version of one engagement, newest first — or, without a company, every
 * version the worker has anywhere (the portal's history; a contractor cannot
 * read worker_companies to name their company). Never includes the v1 read-through.
 */
export const fetchContractVersions = async (
  db: Db,
  workerId: string,
  companyId?: string,
): Promise<ContractVersion[]> => {
  let q = db.from('contract_versions').select('*').eq('worker_id', workerId);
  if (companyId) q = q.eq('company_id', companyId);
  const { data, error } = await q.order('version', { ascending: false });
  if (error) throw new Error(`contract_versions: ${error.message}`);
  return (data ?? []).map(mapVersion);
};

/**
 * The contract of record for one engagement: the ACTIVE version if one exists,
 * else version 1 read through the legacy rows. Null when the worker has no link
 * to this company at all.
 *
 * On the read-through the rate comes from the `rates` row (money source of
 * truth), not the agreement's `f_rate` text; the latest row by start wins so
 * that a rehire still sees the closed rate the engagement ended on.
 */
export const contractOfRecord = async (
  db: Db,
  workerId: string,
  companyId: string,
): Promise<ContractOfRecord | null> => {
  const [active, link, agreement, rate, signature] = await Promise.all([
    db
      .from('contract_versions')
      .select('*')
      .eq('worker_id', workerId)
      .eq('company_id', companyId)
      .eq('status', 'active')
      .maybeSingle(),
    db
      .from('worker_companies')
      .select('contract, role, weekly_hours, started_on')
      .eq('worker_id', workerId)
      .eq('company_id', companyId)
      .maybeSingle(),
    db
      .from('onboarding_agreements')
      .select(
        'f_rate, f_position, f_start_date, f_schedule, f_hours_per_week, addendum_type, addendum_text, countersigned_at, countersigned_name',
      )
      .eq('worker_id', workerId)
      .eq('agreement_kind', 'ic_agreement')
      .maybeSingle(),
    db
      .from('rates')
      .select('amount_php, period_basis, effective_start')
      .eq('worker_id', workerId)
      .eq('company_id', companyId)
      .order('effective_start', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from('onboarding_signatures')
      .select('signed_at, doc_sha256')
      .eq('worker_id', workerId)
      .eq('agreement_kind', 'ic_agreement')
      .eq('doc_version', '1')
      .eq('status', 'signed')
      .maybeSingle(),
  ]);
  for (const r of [active, link, agreement, rate, signature])
    if (r.error) throw new Error(`contract of record: ${r.error.message}`);

  if (active.data) {
    const v = mapVersion(active.data);
    return { ...v, source: 'versioned' };
  }
  if (!link.data) return null;

  const a = agreement.data;
  return {
    source: 'legacy',
    version: 1,
    id: null,
    ratePhp: rate.data ? Number(rate.data.amount_php) : a?.f_rate ? Number(a.f_rate) : null,
    periodBasis: rate.data?.period_basis ?? 'semi_monthly',
    position: a?.f_position ?? link.data.role,
    employmentType: link.data.contract,
    schedule: a?.f_schedule ?? null,
    hoursPerWeek: a?.f_hours_per_week ?? link.data.weekly_hours,
    startDate: a?.f_start_date ?? link.data.started_on,
    effectiveFrom: rate.data?.effective_start ?? null,
    addendumType: a?.addendum_type ?? null,
    addendumText: a?.addendum_text ?? null,
    // The v1 document said "fifteen (15)" in words before the token existed.
    noticeDays: DEFAULT_NOTICE_DAYS,
    signedAt: signature.data?.signed_at ?? null,
    countersignedAt: a?.countersigned_at ?? null,
    countersignedName: a?.countersigned_name ?? null,
    docSha256: signature.data?.doc_sha256 ?? null,
  };
};

/**
 * The ACTIVE version of one engagement, or null — the cheap "has a versioned
 * contract" test (decision 8): while one exists the rate is written by
 * countersign and a direct rate edit is a correction toward it.
 */
export const fetchActiveContractVersion = async (
  db: Db,
  workerId: string,
  companyId: string,
): Promise<ContractVersion | null> => {
  const { data, error } = await db
    .from('contract_versions')
    .select('*')
    .eq('worker_id', workerId)
    .eq('company_id', companyId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new Error(`contract_versions: ${error.message}`);
  return data ? mapVersion(data) : null;
};

/** One version by id, whatever engagement it belongs to. Null when it doesn't exist. */
export const fetchContractVersion = async (db: Db, id: string): Promise<ContractVersion | null> => {
  const { data, error } = await db.from('contract_versions').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`contract_versions: ${error.message}`);
  return data ? mapVersion(data) : null;
};

/**
 * worker_id → sent_at for every version out for signature at one company —
 * the roster's "Awaiting signature · N days" badge. One row per worker at most
 * (the one-in-flight index).
 */
export const fetchAwaitingSignature = async (
  db: Db,
  companyId: string,
): Promise<Record<string, string>> => {
  const { data, error } = await db
    .from('contract_versions')
    .select('worker_id, sent_at')
    .eq('company_id', companyId)
    .eq('status', 'sent');
  if (error) throw new Error(`contract_versions: ${error.message}`);
  const out: Record<string, string> = {};
  for (const r of data ?? []) if (r.sent_at) out[r.worker_id] = r.sent_at;
  return out;
};
