/**
 * Onboarding query module — all onboarding_progress, onboarding_signatures,
 * onboarding_agreements reads/writes (ADR-0002/0003).
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';
import { decryptIfNeeded } from '@/server/crypto';

type Db = SupabaseClient<Database>;

export type OnboardingProgressRow = {
  workerId: string;
  workerName: string;
  workerStatus: Database['public']['Enums']['worker_status'];
  currentStage: Database['public']['Enums']['onboarding_stage'];
  stage1Complete: boolean;
  stage2Complete: boolean;
  stage3Complete: boolean;
  stage1LastKind: Database['public']['Enums']['agreement_kind'] | null;
  stage2LastTab: string | null;
  nameMismatchFlag: boolean;
  stalled: boolean;
  completedAt: string | null;
  startedAt: string;
  updatedAt: string;
};

export type OnboardingSignatureRow = {
  id: string;
  workerId: string;
  agreementKind: Database['public']['Enums']['agreement_kind'];
  signedLegalName: string;
  signatureMethod: Database['public']['Enums']['signature_method'];
  signatureData: string | null;
  docVersion: string;
  docSha256: string | null;
  signedAt: string;
  signedDate: string | null;
  scrolledToEnd: boolean;
  status: Database['public']['Enums']['signature_status'];
  ipAddress: unknown;
  userAgent: string | null;
};

export type OnboardingAgreementRow = {
  workerId: string;
  agreementKind: Database['public']['Enums']['agreement_kind'];
  countersignedAt: string | null;
  countersignedBy: string | null;
  countersignedName: string | null;
  countersignerUserId: string | null;
  countersignerName: string | null;
  countersignMethod: string | null;
  countersignData: string | null;
  countersignIp: string | null;
  fPosition: string | null;
  fRate: string | null;
  fStartDate: string | null;
  fCompanyName: string | null;
  fEmploymentType: string | null;
  fHoursPerWeek: number | null;
  fSchedule: string | null;
  preparedAt: string | null;
  preparedBy: string | null;
};

/** All onboarding progress rows for a company, joined to worker name/status. */
export const fetchOnboardingProgress = async (
  db: Db,
  companyId: string,
): Promise<OnboardingProgressRow[]> => {
  // Join via worker_companies to scope to company
  const { data, error } = await db
    .from('onboarding_progress')
    .select(
      'worker_id, current_stage, stage1_complete, stage2_complete, stage3_complete, stage1_last_kind, stage2_last_tab, name_mismatch_flag, stalled, completed_at, started_at, updated_at, workers!inner(first_name, middle_name, last_name, status, worker_companies!inner(company_id))',
    )
    .eq('workers.worker_companies.company_id', companyId);
  if (error) throw new Error(`onboarding_progress: ${error.message}`);
  return (data ?? []).map((row) => ({
    workerId: row.worker_id,
    workerName: [row.workers?.first_name, row.workers?.middle_name, row.workers?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim(),
    workerStatus: (row.workers?.status ??
      'inactive') as Database['public']['Enums']['worker_status'],
    currentStage: row.current_stage,
    stage1Complete: row.stage1_complete,
    stage2Complete: row.stage2_complete,
    stage3Complete: row.stage3_complete,
    stage1LastKind: row.stage1_last_kind,
    stage2LastTab: row.stage2_last_tab,
    nameMismatchFlag: row.name_mismatch_flag,
    stalled: row.stalled,
    completedAt: row.completed_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  }));
};

export type OnboardingFollowup = { count: number; overdue: number };

/**
 * Open document follow-ups (review_status='deferred') per worker, for the
 * onboarding list — a completed contractor stays visible while they have open
 * follow-ups (legacy parity). `defer_until` in the past = overdue. Keyed by
 * worker_id only: deferred hiring docs carry a NULL company_id, so pass a client
 * that can read them (service) and scope by the onboarding worker ids instead.
 */
export const fetchOnboardingFollowups = async (
  db: Db,
  workerIds: string[],
): Promise<Record<string, OnboardingFollowup>> => {
  if (workerIds.length === 0) return {};
  const { data, error } = await db
    .from('documents')
    .select('worker_id, defer_until')
    .eq('review_status', 'deferred')
    .in('worker_id', workerIds);
  if (error) throw new Error(`onboarding follow-ups: ${error.message}`);
  const today = new Date().toISOString().slice(0, 10);
  const map: Record<string, OnboardingFollowup> = {};
  for (const d of data ?? []) {
    if (!d.worker_id) continue;
    const f = map[d.worker_id] ?? { count: 0, overdue: 0 };
    f.count += 1;
    if (d.defer_until && d.defer_until < today) f.overdue += 1;
    map[d.worker_id] = f;
  }
  return map;
};

/** Single onboarding progress row by worker id. */
export const fetchOnboardingProgressByWorker = async (
  db: Db,
  workerId: string,
): Promise<OnboardingProgressRow | null> => {
  const { data, error } = await db
    .from('onboarding_progress')
    .select(
      'worker_id, current_stage, stage1_complete, stage2_complete, stage3_complete, stage1_last_kind, stage2_last_tab, name_mismatch_flag, stalled, completed_at, started_at, updated_at, workers(first_name, middle_name, last_name, status)',
    )
    .eq('worker_id', workerId)
    .maybeSingle();
  if (error) throw new Error(`onboarding_progress: ${error.message}`);
  if (!data) return null;
  return {
    workerId: data.worker_id,
    workerName: [data.workers?.first_name, data.workers?.middle_name, data.workers?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim(),
    workerStatus: (data.workers?.status ??
      'inactive') as Database['public']['Enums']['worker_status'],
    currentStage: data.current_stage,
    stage1Complete: data.stage1_complete,
    stage2Complete: data.stage2_complete,
    stage3Complete: data.stage3_complete,
    stage1LastKind: data.stage1_last_kind,
    stage2LastTab: data.stage2_last_tab,
    nameMismatchFlag: data.name_mismatch_flag,
    stalled: data.stalled,
    completedAt: data.completed_at,
    startedAt: data.started_at,
    updatedAt: data.updated_at,
  };
};

const SIG_META_COLS =
  'id, worker_id, agreement_kind, signed_legal_name, signature_method, doc_version, doc_sha256, signed_at, signed_date, scrolled_to_end, status, ip_address, user_agent';

type RawSigMeta = Pick<
  Database['public']['Tables']['onboarding_signatures']['Row'],
  | 'id'
  | 'worker_id'
  | 'agreement_kind'
  | 'signed_legal_name'
  | 'signature_method'
  | 'doc_version'
  | 'doc_sha256'
  | 'signed_at'
  | 'signed_date'
  | 'scrolled_to_end'
  | 'status'
  | 'ip_address'
  | 'user_agent'
>;

const mapSigMeta = (s: RawSigMeta): Omit<OnboardingSignatureRow, 'signatureData'> => ({
  id: s.id,
  workerId: s.worker_id,
  agreementKind: s.agreement_kind,
  signedLegalName: s.signed_legal_name,
  signatureMethod: s.signature_method,
  docVersion: s.doc_version,
  docSha256: s.doc_sha256,
  signedAt: s.signed_at,
  signedDate: s.signed_date,
  scrolledToEnd: s.scrolled_to_end,
  status: s.status,
  ipAddress: s.ip_address,
  userAgent: s.user_agent,
});

/**
 * Signatures for a worker, newest first. Pass `{ withData: false }` when the
 * drawn signature image isn't needed (e.g. the admin detail view) — that skips
 * both the base64 blob transfer and the per-row PHI decryption (KMS on prod);
 * the print flows keep the default blob path.
 */
export const fetchSignatures = async (
  db: Db,
  workerId: string,
  opts?: { withData?: boolean },
): Promise<OnboardingSignatureRow[]> => {
  if (opts?.withData === false) {
    const { data, error } = await db
      .from('onboarding_signatures')
      .select(SIG_META_COLS)
      .eq('worker_id', workerId)
      .order('signed_at', { ascending: false });
    if (error) throw new Error(`onboarding_signatures: ${error.message}`);
    return (data ?? []).map((s) => ({ ...mapSigMeta(s), signatureData: null }));
  }

  const { data, error } = await db
    .from('onboarding_signatures')
    .select(`${SIG_META_COLS}, signature_data`)
    .eq('worker_id', workerId)
    .order('signed_at', { ascending: false });
  if (error) throw new Error(`onboarding_signatures: ${error.message}`);
  return Promise.all(
    (data ?? []).map(async (s) => ({
      ...mapSigMeta(s),
      // signature_data is PHI; decrypt envelope tokens, pass legacy plaintext through.
      signatureData: s.signature_data ? await decryptIfNeeded(s.signature_data) : null,
    })),
  );
};

/** Agreements (countersign state) for a worker. */
export const fetchAgreements = async (
  db: Db,
  workerId: string,
): Promise<OnboardingAgreementRow[]> => {
  const { data, error } = await db
    .from('onboarding_agreements')
    .select('*')
    .eq('worker_id', workerId);
  if (error) throw new Error(`onboarding_agreements: ${error.message}`);
  return (data ?? []).map((a) => ({
    workerId: a.worker_id,
    agreementKind: a.agreement_kind,
    countersignedAt: a.countersigned_at,
    countersignedBy: a.countersigned_by,
    countersignedName: a.countersigned_name,
    countersignerUserId: a.countersigner_user_id,
    countersignerName: a.countersigner_name,
    countersignMethod: a.countersign_method,
    countersignData: a.countersign_data,
    countersignIp: a.countersign_ip,
    fPosition: a.f_position,
    fRate: a.f_rate,
    fStartDate: a.f_start_date,
    fCompanyName: a.f_company_name,
    fEmploymentType: a.f_employment_type,
    fHoursPerWeek: a.f_hours_per_week,
    fSchedule: a.f_schedule,
    preparedAt: a.prepared_at,
    preparedBy: a.prepared_by,
  }));
};

/** Contractor login row for a worker. */
export const fetchContractorLogin = async (db: Db, workerId: string) => {
  const { data, error } = await db
    .from('contractor_logins')
    .select('worker_id, auth_user_id, email, status, created_at, last_login_at')
    .eq('worker_id', workerId)
    .maybeSingle();
  if (error) throw new Error(`contractor_logins: ${error.message}`);
  return data;
};

/** Upsert countersign data on an onboarding_agreement. Needs service client. */
export const upsertCountersign = async (
  db: Db,
  workerId: string,
  agreementKind: Database['public']['Enums']['agreement_kind'],
  countersignedBy: string,
  countersignedName: string,
  countersignMethod: 'typed' | 'drawn',
  countersignData: string | null,
): Promise<void> => {
  const now = new Date().toISOString();
  const { error } = await db.from('onboarding_agreements').upsert(
    {
      worker_id: workerId,
      agreement_kind: agreementKind,
      countersigned_by: countersignedBy,
      countersigned_name: countersignedName,
      countersign_method: countersignMethod,
      countersign_data: countersignData,
      countersigned_at: now,
      countersigner_user_id: countersignedBy,
      countersigner_name: countersignedName,
      updated_at: now,
    },
    { onConflict: 'worker_id,agreement_kind' },
  );
  if (error) throw new Error(`countersign upsert: ${error.message}`);
};

/** Insert/upsert onboarding_progress row (seed). */
export const seedOnboardingProgress = async (db: Db, workerId: string): Promise<void> => {
  const { error } = await db
    .from('onboarding_progress')
    .upsert(
      { worker_id: workerId, current_stage: 'stage1_sign' },
      { onConflict: 'worker_id', ignoreDuplicates: true },
    );
  if (error) throw new Error(`seed onboarding_progress: ${error.message}`);
};
