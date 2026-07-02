'use server';

/**
 * Portal document actions (ported from legacy `useOutstandingDocs` +
 * `UploadSlot`/`DocsView` upload, portal/index.html ~861-960, 1102-1153,
 * 1940-2010).
 *
 *  - `fetchOutstandingDocSlots` computes REQUIRED-but-missing document slots
 *    from `portal_settings.onboarding_config.documents` (falling back to the
 *    legacy DEFAULT_DOCS), matched against the contractor's own documents. A
 *    slot is "outstanding" when there is no latest upload for it, or the latest
 *    upload is in `needs_replacement` / `deferred`.
 *  - `uploadOwnDocument` puts the chosen file in the `contractor-docs` storage
 *    bucket and inserts a `documents` row (mirrors the legacy client-side
 *    upload + insert; uses the service client AFTER requireWorker() because the
 *    contractor-docs storage policies live out-of-band, same as
 *    getDocumentSignedUrl in portal.ts).
 */

import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import { parseOnboardingConfig } from '@/db/queries/config';
import { fetchWorkerDocuments, type WorkerDocumentRow } from '@/db/queries/documents';
import { fetchContractorLogin } from '@/db/queries/onboarding';
import { fetchOwnDocuments } from '@/db/queries/portal';
import type { Database } from '@/db/types';
import { parseDocUploadForm } from '@/lib/onboarding/doc-upload';
import { deriveDocChecklist, outstandingSlots } from '@/lib/onboarding/documents';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { type CurrentAdmin, getCurrentAdmin } from '@/server/auth/admin';
import { requireWorker } from '@/server/auth/worker';
import { getEmployerCompanyId } from '@/server/company';

/** A single required document the contractor still owes (one per side). */
export interface OutstandingDocSlot {
  kind: string;
  side: string | null;
  /** Verbatim doc-title label (legacy `slot.label`). */
  label: string;
  /** Months until the document expires (NBI = 6); drives the date-issued input. */
  freshnessMonths: number | null;
}

/**
 * Required-but-missing document slots for the authenticated contractor. Built
 * from the shared checklist (src/lib/onboarding/documents.ts): expand each
 * configured REQUIRED doc into slots (one per side), then keep only those with
 * no latest upload or a latest upload still needing action.
 */
export async function fetchOutstandingDocSlots(): Promise<OutstandingDocSlot[]> {
  const worker = await requireWorker();
  const db = await createServerSupabase();

  const [{ data: settings }, docs] = await Promise.all([
    db.from('portal_settings').select('onboarding_config').eq('id', 1).maybeSingle(),
    fetchOwnDocuments(db, worker.workerId),
  ]);

  const cfg = parseOnboardingConfig(settings?.onboarding_config);
  const checklist = deriveDocChecklist(cfg.documents, docs);
  return outstandingSlots(checklist).map((s) => ({
    kind: s.kind,
    side: s.side,
    label: s.label,
    freshnessMonths: s.freshnessMonths,
  }));
}

/**
 * Company-scope gate shared by the admin document actions (list / upload —
 * same pattern as sendToolsEmail): a non-owner admin must share a company
 * with the worker.
 */
async function adminInScopeForWorker(admin: CurrentAdmin, workerId: string): Promise<boolean> {
  if (admin.isOwner) return true;
  const db = await createServerSupabase();
  const { data: links } = await db
    .from('worker_companies')
    .select('company_id')
    .eq('worker_id', workerId);
  return (links ?? []).some((l) => admin.companyIds.includes(l.company_id));
}

/**
 * All of a worker's documents for the admin Documents tab — the full upload
 * history per kind, newest first, including fileless waived/deferred rows.
 */
export async function listContractorDocuments(args: {
  workerId: string;
}): Promise<ActionResult<{ documents: WorkerDocumentRow[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  try {
    if (!(await adminInScopeForWorker(admin, args.workerId)))
      return { ok: false, error: 'Not authorized for this contractor.' };
    // Service client after the admin gate — admin RLS is company-filtered,
    // not worker-filtered (same precedent as getOnboardingDetail).
    const documents = await fetchWorkerDocuments(createServiceClient(), args.workerId);
    return { ok: true, data: { documents } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Lookup failed.' };
  }
}

/**
 * Shared upload + insert used by both the contractor self-upload and the admin
 * upload-for-contractor: put the file in the `contractor-docs` bucket under
 * `pathPrefix` and insert a `documents` row (review_status=pending).
 */
async function storeDocument(
  workerId: string,
  pathPrefix: string,
  parsed: {
    file: File;
    kind: Database['public']['Enums']['document_kind'];
    side: string | null;
    issuedOn: string | null;
  },
): Promise<ActionResult> {
  const { file, kind, side, issuedOn } = parsed;
  const svc = createServiceClient();

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${pathPrefix}/${kind}/${Date.now()}-${side ? `${side}-` : ''}${safeName}`;
  const up = await svc.storage.from('contractor-docs').upload(path, file, { upsert: false });
  if (up.error) return { ok: false, error: `Upload failed: ${up.error.message}` };

  // Attribute the doc to the employer company so it shows on the Documents page.
  const employerCompanyId = await getEmployerCompanyId(svc);
  const row: Database['public']['Tables']['documents']['Insert'] = {
    worker_id: workerId,
    kind,
    storage_path: path,
    title: file.name,
    mime_type: file.type,
    file_size_bytes: file.size,
    review_status: 'pending',
    ...(employerCompanyId ? { company_id: employerCompanyId } : {}),
    ...(side ? { side } : {}),
    ...(kind === 'nbi_clearance' && issuedOn ? { issued_on: issuedOn } : {}),
  };
  const ins = await svc.from('documents').insert(row);
  if (ins.error) return { ok: false, error: `Upload failed: ${ins.error.message}` };

  return { ok: true };
}

/**
 * Upload a contractor document. Ports the legacy `UploadSlot.doUpload` /
 * `DocsView.upload`: validate mime + size, upload to the `contractor-docs`
 * bucket, then insert a `documents` row (review_status=pending). `side` is set
 * for two-sided docs; `issuedOn` is required for NBI clearance.
 */
export async function uploadOwnDocument(form: FormData): Promise<ActionResult> {
  const worker = await requireWorker();

  const parsed = parseDocUploadForm(form);
  if (!parsed.ok) return parsed;

  try {
    // Service client AFTER requireWorker(): the contractor-docs storage policies
    // live out-of-band, mirroring getDocumentSignedUrl in portal.ts.
    return await storeDocument(worker.workerId, worker.userId, parsed.value);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Upload failed.',
    };
  }
}

/**
 * Admin uploads a document on the contractor's behalf (Onboarding drilldown
 * Documents section). Same validation, bucket, and row shape as the
 * self-upload; the row lands as review_status=pending so the existing Approve
 * button stamps reviewed_by/reviewed_at.
 */
export async function uploadDocumentForContractor(form: FormData): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const workerIdRaw = form.get('workerId');
  const workerId = typeof workerIdRaw === 'string' ? workerIdRaw : '';
  if (!workerId) return { ok: false, error: 'Missing contractor.' };

  const parsed = parseDocUploadForm(form);
  if (!parsed.ok) return parsed;

  try {
    if (!(await adminInScopeForWorker(admin, workerId)))
      return { ok: false, error: 'Not authorized for this contractor.' };

    // Folder prefix: the contractor's auth uid when a portal login exists, else
    // the worker id. ponytail: reads always go through service-client signed
    // URLs from documents.storage_path, so the prefix is never parsed — the
    // auth-uid convention is kept only for storage-RLS consistency.
    const svc = createServiceClient();
    const login = await fetchContractorLogin(svc, workerId);
    const prefix = login?.auth_user_id ?? workerId;

    const res = await storeDocument(workerId, prefix, parsed.value);
    if (!res.ok) return res;

    const { kind, side, file } = parsed.value;
    await logEvent({
      action: 'document.uploaded_by_admin',
      entity: `${kind}${side ? ` (${side})` : ''} · ${workerId}`,
      detail: { worker_id: workerId, kind, side, title: file.name, by: admin.email },
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Upload failed.',
    };
  }
}
