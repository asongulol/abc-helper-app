import type { Database } from '@/db/types';

type DocumentKind = Database['public']['Enums']['document_kind'];

const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
/**
 * Largest file a document upload accepts. Uploads travel in a Server Action
 * body: next.config's bodySizeLimit (4 MB) and Vercel's 4.5 MB request cap
 * sit above this, with headroom for the multipart envelope. The browser shrinks
 * bigger photos to fit first (`fitForUpload`).
 */
export const UPLOAD_MAX_BYTES = 3.5 * 1024 * 1024;
const VALID_KINDS = new Set<string>([
  'ic_agreement',
  'w8ben',
  'gov_id',
  'other',
  'resume',
  'diploma',
  'nbi_clearance',
]);

export type ParsedDocUpload = {
  file: File;
  kind: DocumentKind;
  side: string | null;
  issuedOn: string | null;
};

/**
 * Validate a document-upload FormData — same messages and check order as the
 * legacy portal flow. Pure (FormData/File are runtime globals), shared by the
 * contractor self-upload and the admin upload-for-contractor actions.
 */
export const parseDocUploadForm = (
  form: FormData,
): { ok: true; value: ParsedDocUpload } | { ok: false; error: string } => {
  const file = form.get('file');
  const kind = String(form.get('kind') ?? '');
  const sideRaw = form.get('side');
  const side = typeof sideRaw === 'string' && sideRaw ? sideRaw : null;
  const issuedRaw = form.get('issuedOn');
  const issuedOn = typeof issuedRaw === 'string' && issuedRaw ? issuedRaw : null;

  if (!(file instanceof File)) return { ok: false, error: 'Choose a file first.' };
  if (file.size === 0) return { ok: false, error: 'File is empty.' };
  if (!VALID_KINDS.has(kind)) return { ok: false, error: 'Unknown document type.' };
  if (!ALLOWED_MIME.has(file.type)) return { ok: false, error: 'File must be a PDF, JPG or PNG.' };
  if (file.size > UPLOAD_MAX_BYTES) return { ok: false, error: 'File is too large (max 3.5 MB).' };
  if (kind === 'nbi_clearance' && !issuedOn)
    return { ok: false, error: 'Enter the date the NBI clearance was issued.' };
  return { ok: true, value: { file, kind: kind as DocumentKind, side, issuedOn } };
};
