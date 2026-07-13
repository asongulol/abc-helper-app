import { describe, expect, it } from 'vitest';
import { parseDocUploadForm } from '@/lib/onboarding/doc-upload';

const file = (over?: { name?: string; type?: string; size?: number }) => {
  const bytes = new Uint8Array(over?.size ?? 4);
  return new File([bytes], over?.name ?? 'scan.pdf', { type: over?.type ?? 'application/pdf' });
};

const form = (fields: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('parseDocUploadForm', () => {
  it('rejects a missing file', () => {
    expect(parseDocUploadForm(form({ kind: 'resume' }))).toEqual({
      ok: false,
      error: 'Choose a file first.',
    });
  });

  it('distinguishes a chosen-but-empty file from no file (#038)', () => {
    expect(parseDocUploadForm(form({ kind: 'resume', file: file({ size: 0 }) }))).toEqual({
      ok: false,
      error: 'File is empty.',
    });
  });

  it('rejects an unknown kind', () => {
    expect(parseDocUploadForm(form({ kind: 'passport', file: file() }))).toEqual({
      ok: false,
      error: 'Unknown document type.',
    });
  });

  it('rejects a disallowed MIME type', () => {
    expect(
      parseDocUploadForm(form({ kind: 'resume', file: file({ type: 'text/plain' }) })),
    ).toEqual({ ok: false, error: 'File must be a PDF, JPG or PNG.' });
  });

  it('rejects a file over 10 MB', () => {
    expect(
      parseDocUploadForm(form({ kind: 'resume', file: file({ size: 10 * 1024 * 1024 + 1 }) })),
    ).toEqual({ ok: false, error: 'File is too large (max 10 MB).' });
  });

  it('requires an issued date for NBI clearance', () => {
    expect(parseDocUploadForm(form({ kind: 'nbi_clearance', file: file() }))).toEqual({
      ok: false,
      error: 'Enter the date the NBI clearance was issued.',
    });
  });

  it('accepts a valid upload with side and normalizes blanks to null', () => {
    const res = parseDocUploadForm(
      form({ kind: 'gov_id', side: 'front', file: file({ type: 'image/png', name: 'id.png' }) }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.kind).toBe('gov_id');
      expect(res.value.side).toBe('front');
      expect(res.value.issuedOn).toBeNull();
      expect(res.value.file.name).toBe('id.png');
    }
    const noSide = parseDocUploadForm(form({ kind: 'resume', side: '', file: file() }));
    expect(noSide.ok && noSide.value.side).toBeNull();
  });
});
