/**
 * contract_versions reads (docs/CONTRACT-VERSIONS-PLAN.md §2).
 *
 * Rows here start at version 2. Version 1 of every current engagement is the
 * existing onboarding_agreements.ic_agreement row + its doc_version '1' / '1.0'
 * signature, read through here as `source: 'legacy'` — no backfill, and the
 * legacy portal keeps rendering that row untouched.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';
import { DEFAULT_NOTICE_DAYS } from '@/lib/agreements/merge';
import { type AgreementKind, type PackageStatus, packageStatusOf } from '@/lib/contracts/package';
import type { ContractChangeDetail, ContractChangeReason } from '@/types/schemas/contracts';

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
  /** Why this version exists; null on rows drafted before the wizard. */
  changeReason: ContractChangeReason | null;
  /** Admin-only — never rendered on a contractor-visible view. */
  changeNote: string | null;
  /** How the rate was arrived at, and an overpayment note once voided after pay. */
  changeDetail: ContractChangeDetail | null;
  /** The re-sign package (decision 8) and, once sent, its due date (decision 9). */
  resignKinds: AgreementKind[];
  resignDueOn: string | null;
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
  /**
   * The latest `rates` row — the money the engine is using today. Equals
   * ratePhp unless the rate was edited outside a version; the wizard's
   * Increase step offers both as the base when they differ (decision 4).
   */
  liveRatePhp: number | null;
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
  changeReason: r.change_reason as ContractChangeReason | null,
  changeNote: r.change_note,
  changeDetail: r.change_detail as ContractChangeDetail | null,
  resignKinds: r.resign_kinds ?? [],
  resignDueOn: r.resign_due_on,
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
/**
 * Version-1 signatures predate contract_versions: the legacy portal stamped the
 * template's version string ('1.0' on every prod row) and the app stamps '1'.
 * Versioned signatures carry the integer version (2, 3, …), so anything else
 * is the original agreement.
 */
export const isLegacySignatureVersion = (docVersion: string): boolean =>
  !(/^\d+$/.test(docVersion) && Number(docVersion) >= 2);

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
      .select('signed_at, doc_sha256, doc_version')
      .eq('worker_id', workerId)
      .eq('agreement_kind', 'ic_agreement')
      .eq('status', 'signed'),
  ]);
  for (const r of [active, link, agreement, rate, signature])
    if (r.error) throw new Error(`contract of record: ${r.error.message}`);
  const v1 = (signature.data ?? []).find((s) => isLegacySignatureVersion(s.doc_version)) ?? null;
  const liveRatePhp = rate.data ? Number(rate.data.amount_php) : null;

  if (active.data) {
    const v = mapVersion(active.data);
    return { ...v, source: 'versioned', liveRatePhp };
  }
  if (!link.data) return null;

  const a = agreement.data;
  return {
    source: 'legacy',
    version: 1,
    id: null,
    liveRatePhp,
    ratePhp: liveRatePhp ?? (a?.f_rate ? Number(a.f_rate) : null),
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
    signedAt: v1?.signed_at ?? null,
    countersignedAt: a?.countersigned_at ?? null,
    countersignedName: a?.countersigned_name ?? null,
    docSha256: v1?.doc_sha256 ?? null,
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

export type PendingContractRate = {
  workerId: string;
  version: number;
  ratePhp: number;
  effectiveFrom: string;
};

/**
 * Every version out for signature or signed-not-countersigned at one company,
 * as the rate it will write — what Calculate overlays on the `rates` rows
 * (early pricing, docs/CONTRACT-CHANGE-WIZARD-PLAN.md decision 5). At most one
 * per worker (the one-in-flight index).
 */
export const fetchPendingContractRates = async (
  db: Db,
  companyId: string,
): Promise<PendingContractRate[]> => {
  const { data, error } = await db
    .from('contract_versions')
    .select('worker_id, version, rate_php, effective_from')
    .eq('company_id', companyId)
    .in('status', ['sent', 'signed']);
  if (error) throw new Error(`contract_versions: ${error.message}`);
  return (data ?? []).map((r) => ({
    workerId: r.worker_id,
    version: r.version,
    ratePhp: Number(r.rate_php),
    effectiveFrom: r.effective_from,
  }));
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

/**
 * worker_id → the re-sign package they are working through (decisions 8–9):
 * the newest sent / signed / active version that asked for one, judged against
 * the signatures currently `signed`. Scope by company, by workers, or both;
 * workers with no package are absent. What Calculate's hold, the portal's
 * signing card, the Current team row and the reminder all read.
 */
export const fetchOutstandingPackages = async (
  db: Db,
  scope: { companyId?: string | undefined; workerIds?: readonly string[] | undefined },
): Promise<Map<string, PackageStatus>> => {
  let q = db
    .from('contract_versions')
    .select('worker_id, version, status, resign_kinds, resign_due_on, sent_at')
    .in('status', ['sent', 'signed', 'active']);
  if (scope.companyId) q = q.eq('company_id', scope.companyId);
  if (scope.workerIds) q = q.in('worker_id', [...scope.workerIds]);
  const { data, error } = await q;
  if (error) throw new Error(`contract_versions: ${error.message}`);
  const byWorker = new Map<string, Parameters<typeof packageStatusOf>[0][number][]>();
  for (const r of data ?? []) {
    if (!r.resign_kinds?.length) continue;
    const list = byWorker.get(r.worker_id) ?? [];
    list.push({
      version: r.version,
      status: r.status,
      resignKinds: r.resign_kinds,
      resignDueOn: r.resign_due_on,
      sentAt: r.sent_at,
    });
    byWorker.set(r.worker_id, list);
  }
  const out = new Map<string, PackageStatus>();
  if (byWorker.size === 0) return out;
  const { data: sigs, error: sigErr } = await db
    .from('onboarding_signatures')
    .select('worker_id, agreement_kind')
    .eq('status', 'signed')
    .in('worker_id', [...byWorker.keys()]);
  if (sigErr) throw new Error(`onboarding_signatures: ${sigErr.message}`);
  const signedBy = new Map<string, Set<AgreementKind>>();
  for (const s of sigs ?? [])
    signedBy.set(s.worker_id, (signedBy.get(s.worker_id) ?? new Set()).add(s.agreement_kind));
  for (const [workerId, versions] of byWorker) {
    const pkg = packageStatusOf(versions, signedBy.get(workerId) ?? new Set());
    if (pkg) out.set(workerId, pkg);
  }
  return out;
};
