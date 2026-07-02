/**
 * Documents query module — ALL documents DB reads/writes (ADR-0002/0003).
 * Callers pass an already-created Supabase client. Admin reads use the RLS
 * user client; privileged writes (review decisions) use the service client
 * only after a role check.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';

type Db = SupabaseClient<Database>;

export type DocumentRow = {
  id: string;
  workerId: string;
  workerName: string;
  companyId: string | null;
  kind: Database['public']['Enums']['document_kind'];
  title: string | null;
  reviewStatus: Database['public']['Enums']['review_status'];
  reviewReason: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  storagePath: string | null;
  expiresOn: string | null;
  issuedOn: string | null;
  signedOn: string | null;
  side: string | null;
  createdAt: string;
  mimeType: string | null;
  fileSizeBytes: number | null;
};

/** All documents for a company (admin view), ordered newest-first. */
export const fetchDocuments = async (db: Db, companyId: string): Promise<DocumentRow[]> => {
  const { data, error } = await db
    .from('documents')
    .select(
      'id, worker_id, company_id, kind, title, review_status, review_reason, reviewed_at, reviewed_by, storage_path, expires_on, issued_on, signed_on, side, created_at, mime_type, file_size_bytes, workers(first_name, middle_name, last_name)',
    )
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`documents: ${error.message}`);
  return (data ?? []).map((d) => ({
    id: d.id,
    workerId: d.worker_id,
    workerName: [d.workers?.first_name, d.workers?.middle_name, d.workers?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim(),
    companyId: d.company_id,
    kind: d.kind,
    title: d.title,
    reviewStatus: d.review_status,
    reviewReason: d.review_reason,
    reviewedAt: d.reviewed_at,
    reviewedBy: d.reviewed_by,
    storagePath: d.storage_path,
    expiresOn: d.expires_on,
    issuedOn: d.issued_on,
    signedOn: d.signed_on,
    side: d.side,
    createdAt: d.created_at,
    mimeType: d.mime_type,
    fileSizeBytes: d.file_size_bytes,
  }));
};

/** Single document by id (admin). */
export const fetchDocument = async (db: Db, documentId: string): Promise<DocumentRow | null> => {
  const { data, error } = await db
    .from('documents')
    .select(
      'id, worker_id, company_id, kind, title, review_status, review_reason, reviewed_at, reviewed_by, storage_path, expires_on, issued_on, signed_on, side, created_at, mime_type, file_size_bytes, workers(first_name, middle_name, last_name)',
    )
    .eq('id', documentId)
    .maybeSingle();
  if (error) throw new Error(`document: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    workerId: data.worker_id,
    workerName: [data.workers?.first_name, data.workers?.middle_name, data.workers?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim(),
    companyId: data.company_id,
    kind: data.kind,
    title: data.title,
    reviewStatus: data.review_status,
    reviewReason: data.review_reason,
    reviewedAt: data.reviewed_at,
    reviewedBy: data.reviewed_by,
    storagePath: data.storage_path,
    expiresOn: data.expires_on,
    issuedOn: data.issued_on,
    signedOn: data.signed_on,
    side: data.side,
    createdAt: data.created_at,
    mimeType: data.mime_type,
    fileSizeBytes: data.file_size_bytes,
  };
};

export type WorkerDocumentRow = {
  id: string;
  kind: Database['public']['Enums']['document_kind'];
  side: string | null;
  title: string | null;
  storagePath: string | null;
  reviewStatus: Database['public']['Enums']['review_status'];
  issuedOn: string | null;
  /** Defer-until date for deferred rows (review reuses expires_on as due date). */
  expiresOn: string | null;
  createdAt: string;
};

/**
 * All documents for one worker (admin per-worker view), newest-first — the
 * full upload history per kind, including fileless waived/deferred
 * placeholders (they carry status and are deletable).
 */
export const fetchWorkerDocuments = async (
  db: Db,
  workerId: string,
): Promise<WorkerDocumentRow[]> => {
  const { data, error } = await db
    .from('documents')
    .select('id, kind, side, title, storage_path, review_status, issued_on, expires_on, created_at')
    .eq('worker_id', workerId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`worker documents: ${error.message}`);
  return (data ?? []).map((d) => ({
    id: d.id,
    kind: d.kind,
    side: d.side,
    title: d.title,
    storagePath: d.storage_path,
    reviewStatus: d.review_status,
    issuedOn: d.issued_on,
    expiresOn: d.expires_on,
    createdAt: d.created_at,
  }));
};

/**
 * Delete any fileless (no upload) placeholder rows for a worker's doc slot.
 * Never touches real uploads (those have a storage_path).
 */
export const clearFilelessDocumentSlot = async (
  db: Db,
  workerId: string,
  kind: Database['public']['Enums']['document_kind'],
  side: string | null,
): Promise<void> => {
  let q = db
    .from('documents')
    .delete()
    .eq('worker_id', workerId)
    .eq('kind', kind)
    .is('storage_path', null);
  q = side === null ? q.is('side', null) : q.eq('side', side);
  const { error } = await q;
  if (error) throw new Error(`clear placeholder: ${error.message}`);
};

/**
 * Record an admin waive/defer for a REQUIRED document the contractor hasn't
 * uploaded yet, as a fileless documents row (storage_path null). A prior
 * fileless placeholder for the same slot is replaced so they don't accumulate.
 * `expiresOn` carries the defer-until date (null for a waiver). Service client.
 */
export const resolveMissingDocumentSlot = async (
  db: Db,
  args: {
    workerId: string;
    kind: Database['public']['Enums']['document_kind'];
    side: string | null;
    reviewStatus: 'waived' | 'deferred';
    reviewedBy: string;
    reviewReason: string | null;
    expiresOn: string | null;
    title: string;
    /** Employer company the doc belongs to (so it shows on the Documents page). */
    companyId: string | null;
  },
): Promise<void> => {
  await clearFilelessDocumentSlot(db, args.workerId, args.kind, args.side);
  const { error } = await db.from('documents').insert({
    worker_id: args.workerId,
    kind: args.kind,
    side: args.side,
    review_status: args.reviewStatus,
    reviewed_by: args.reviewedBy,
    reviewed_at: new Date().toISOString(),
    review_reason: args.reviewReason,
    expires_on: args.expiresOn,
    title: args.title,
    ...(args.companyId ? { company_id: args.companyId } : {}),
  });
  if (error) throw new Error(`resolve missing document: ${error.message}`);
};

/** Update review status/reason on a document. Uses service client (caller checks). */
export const updateDocumentReview = async (
  db: Db,
  documentId: string,
  reviewStatus: Database['public']['Enums']['review_status'],
  reviewedBy: string,
  reviewReason: string | null,
): Promise<void> => {
  const { error } = await db
    .from('documents')
    .update({
      review_status: reviewStatus,
      review_reason: reviewReason,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', documentId);
  if (error) throw new Error(`update document review: ${error.message}`);
};

// ---------------------------------------------------------------------------
// Expiry-check queries (used by src/server/documents/service.ts and backed by
// src/lib/documents/expiry.ts — the pure classifier).
// ---------------------------------------------------------------------------

import type { ExpiryInput } from '@/lib/documents/expiry';
import type { HiringDocInput } from '@/lib/documents/hiring-review';
import { ONBOARDING_DOC_KINDS } from '@/lib/documents/hiring-review';

/**
 * Fetch all active-worker documents that have an expiresOn within
 * `today + withinDays + 1` (the +1-day server-side slack matches the legacy
 * edge fn so the pure JS classifier is still authoritative for the boundary).
 *
 * Only returns documents for active workers. Caller passes the result to
 * `classifyExpiry()` from `src/lib/documents/expiry.ts`.
 */
export const fetchDocumentsForExpiryCheck = async (
  db: Db,
  today: Date,
  withinDays: number,
): Promise<ExpiryInput[]> => {
  const upper = new Date(today.getTime() + (withinDays + 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const { data, error } = await db
    .from('documents')
    .select(
      'id, kind, title, expires_on, worker_id, workers(first_name, middle_name, last_name, status), companies(name)',
    )
    .lte('expires_on', upper)
    // Exclude fileless rows: a waived/deferred placeholder reuses expires_on as a
    // "due date", but with no uploaded file there's nothing that can expire — it
    // must not surface as an "overdue/expiring document" in the expiry digest.
    .not('storage_path', 'is', null)
    .order('expires_on', { ascending: true });

  if (error) throw new Error(`fetchDocumentsForExpiryCheck: ${error.message}`);

  return (data ?? [])
    .filter(
      (d) =>
        d.expires_on !== null &&
        d.workers !== null &&
        (!d.workers.status || d.workers.status === 'active'),
    )
    .map((d) => ({
      workerName:
        [d.workers?.first_name, d.workers?.middle_name, d.workers?.last_name]
          .filter(Boolean)
          .join(' ')
          .trim() || '(unknown)',
      companyName: (d as { companies?: { name?: string | null } | null }).companies?.name ?? '',
      kind: d.kind,
      title: d.title,
      // Safe: filtered nulls above
      expiresOn: d.expires_on as string,
    }));
};

/**
 * Fetch onboarding-kind documents for active workers, ordered newest-first.
 * Caller passes the result to `classifyHiringReview()` from
 * `src/lib/documents/hiring-review.ts`.
 */
export const fetchDocumentsForHiringReview = async (db: Db): Promise<HiringDocInput[]> => {
  const { data, error } = await db
    .from('documents')
    .select(
      'id, kind, side, review_status, created_at, worker_id, workers(first_name, middle_name, last_name, status, email), companies(name)',
    )
    .in('kind', ONBOARDING_DOC_KINDS as Database['public']['Enums']['document_kind'][])
    .order('created_at', { ascending: false });

  if (error) throw new Error(`fetchDocumentsForHiringReview: ${error.message}`);

  return (data ?? [])
    .filter((d) => d.workers !== null && (!d.workers.status || d.workers.status === 'active'))
    .map((d) => ({
      workerId: d.worker_id,
      workerName:
        [d.workers?.first_name, d.workers?.middle_name, d.workers?.last_name]
          .filter(Boolean)
          .join(' ')
          .trim() || '(unknown)',
      companyName: (d as { companies?: { name?: string | null } | null }).companies?.name ?? '',
      workerEmail: d.workers?.email ?? '',
      kind: d.kind,
      side: d.side,
      reviewStatus: d.review_status,
      createdAt: d.created_at,
    }));
};

// ---------------------------------------------------------------------------

/** Fetch onboarding_progress rows for a list of worker IDs (for stage3 re-eval). */
export const fetchOnboardingProgressForWorker = async (db: Db, workerId: string) => {
  const { data, error } = await db
    .from('onboarding_progress')
    .select('stage1_complete, stage2_complete, stage3_complete, completed_at, current_stage')
    .eq('worker_id', workerId)
    .maybeSingle();
  if (error) throw new Error(`onboarding_progress: ${error.message}`);
  return data;
};

/** Fetch approved documents for a worker (for stage3 completion eval). */
export const fetchApprovedDocumentsForWorker = async (db: Db, workerId: string) => {
  const { data, error } = await db
    .from('documents')
    .select('id, kind, side, storage_path, review_status')
    .eq('worker_id', workerId)
    .in('review_status', ['approved', 'waived', 'deferred']);
  if (error) throw new Error(`approved docs: ${error.message}`);
  return data ?? [];
};

/** Update onboarding_progress after doc review re-eval. */
export const updateOnboardingProgressStage3 = async (
  db: Db,
  workerId: string,
  stage3Complete: boolean,
  onboardingComplete: boolean,
): Promise<void> => {
  const now = new Date().toISOString();
  const patch: Database['public']['Tables']['onboarding_progress']['Update'] = {
    stage3_complete: stage3Complete,
    updated_at: now,
  };
  if (onboardingComplete) {
    patch.completed_at = now;
    patch.current_stage = 'complete';
  }
  const { error } = await db.from('onboarding_progress').update(patch).eq('worker_id', workerId);
  if (error) throw new Error(`update onboarding stage3: ${error.message}`);
};
