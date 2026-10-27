/**
 * Make a document fit the upload transport. Files go to the server inside a
 * Server Action body, which Next caps (next.config bodySizeLimit) and Vercel
 * caps again at 4.5 MB — a phone photo of an ID is often bigger, and an
 * over-cap request never reaches the action: the portal just crashes with
 * "An unexpected response was received from the server."
 *
 * Photos over the limit are re-encoded in the browser as a smaller JPEG (long
 * side ≤ 2400 px, still legible for an ID). A PDF can't be shrunk here, so an
 * oversized one gets a clear message instead of the crash.
 * ponytail: action-body transport, so the ceiling is ~4 MB; direct-to-storage
 * signed uploads lift it if large scanned PDFs become common.
 */
import { UPLOAD_MAX_BYTES } from '@/lib/onboarding/doc-upload';

const MAX_SIDE = 2400;

export type FitResult = { ok: true; file: File } | { ok: false; error: string };

const tooLarge = (): FitResult => ({
  ok: false,
  error: `File is too large (max ${UPLOAD_MAX_BYTES / 1024 / 1024} MB). Use a smaller file or a photo instead of a scan.`,
});

const encode = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

export const fitForUpload = async (file: File): Promise<FitResult> => {
  if (file.size <= UPLOAD_MAX_BYTES) return { ok: true, file };
  if (!/^image\/(jpeg|png)$/.test(file.type)) return tooLarge();
  try {
    const img = await createImageBitmap(file); // honours EXIF rotation
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close();
    for (const q of [0.85, 0.7]) {
      const blob = await encode(canvas, q);
      if (blob && blob.size <= UPLOAD_MAX_BYTES)
        return {
          ok: true,
          file: new File([blob], `${file.name.replace(/\.\w+$/, '')}.jpg`, { type: 'image/jpeg' }),
        };
    }
  } catch {
    /* undecodable image — fall through to the size message */
  }
  return tooLarge();
};
