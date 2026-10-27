import { describe, expect, it } from 'vitest';
import { fitForUpload } from '@/lib/documents/fit-upload';
import { UPLOAD_MAX_BYTES } from '@/lib/onboarding/doc-upload';

const fileOf = (size: number, type: string) => new File([new Uint8Array(size)], 'x', { type });

describe('fitForUpload', () => {
  it('passes a file under the limit through untouched', async () => {
    const f = fileOf(500_000, 'image/jpeg');
    expect(await fitForUpload(f)).toEqual({ ok: true, file: f });
  });

  it('refuses an oversized PDF with a clear message instead of sending it', async () => {
    const res = await fitForUpload(fileOf(UPLOAD_MAX_BYTES + 1, 'application/pdf'));
    expect(res).toEqual({ ok: false, error: expect.stringContaining('too large (max 3.5 MB)') });
  });
});
