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
import { fetchOwnDocuments } from '@/db/queries/portal';
import type { Database } from '@/db/types';
import { deriveDocChecklist, outstandingSlots } from '@/lib/onboarding/documents';
import type { ActionResult } from '@/server/actions/portal-admin';
import { requireWorker } from '@/server/auth/worker';

type DocumentKind = Database['public']['Enums']['document_kind'];

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

const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const MAX_BYTES = 10 * 1024 * 1024;
const VALID_KINDS = new Set<string>([
  'ic_agreement',
  'w8ben',
  'gov_id',
  'other',
  'resume',
  'diploma',
  'nbi_clearance',
]);

/**
 * Upload a contractor document. Ports the legacy `UploadSlot.doUpload` /
 * `DocsView.upload`: validate mime + size, upload to the `contractor-docs`
 * bucket, then insert a `documents` row (review_status=pending). `side` is set
 * for two-sided docs; `issuedOn` is required for NBI clearance.
 */
export async function uploadOwnDocument(form: FormData): Promise<ActionResult> {
  const worker = await requireWorker();

  const file = form.get('file');
  const kind = String(form.get('kind') ?? '');
  const sideRaw = form.get('side');
  const side = typeof sideRaw === 'string' && sideRaw ? sideRaw : null;
  const issuedRaw = form.get('issuedOn');
  const issuedOn = typeof issuedRaw === 'string' && issuedRaw ? issuedRaw : null;

  if (!(file instanceof File) || file.size === 0)
    return { ok: false, error: 'Choose a file first.' };
  if (!VALID_KINDS.has(kind)) return { ok: false, error: 'Unknown document type.' };
  if (!ALLOWED_MIME.has(file.type)) return { ok: false, error: 'File must be a PDF, JPG or PNG.' };
  if (file.size > MAX_BYTES) return { ok: false, error: 'File is too large (max 10 MB).' };
  if (kind === 'nbi_clearance' && !issuedOn)
    return { ok: false, error: 'Enter the date the NBI clearance was issued.' };

  try {
    // Service client AFTER requireWorker(): the contractor-docs storage policies
    // live out-of-band, mirroring getDocumentSignedUrl in portal.ts.
    const svc = createServiceClient();

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${worker.userId}/${kind}/${Date.now()}-${side ? `${side}-` : ''}${safeName}`;
    const up = await svc.storage.from('contractor-docs').upload(path, file, { upsert: false });
    if (up.error) return { ok: false, error: `Upload failed: ${up.error.message}` };

    const row: Database['public']['Tables']['documents']['Insert'] = {
      worker_id: worker.workerId,
      kind: kind as DocumentKind,
      storage_path: path,
      title: file.name,
      mime_type: file.type,
      file_size_bytes: file.size,
      review_status: 'pending',
      ...(side ? { side } : {}),
      ...(kind === 'nbi_clearance' && issuedOn ? { issued_on: issuedOn } : {}),
    };
    const ins = await svc.from('documents').insert(row);
    if (ins.error) return { ok: false, error: `Upload failed: ${ins.error.message}` };

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Upload failed.' };
  }
}
