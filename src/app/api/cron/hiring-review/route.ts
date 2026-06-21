import { NextResponse } from 'next/server';
import { isValidCronRequest } from '@/server/cron';
import { runHiringReviewCheck } from '@/server/documents/service';

// nodemailer (email digest) + the service-role client require the Node runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Scheduled hiring-docs-review digest. Runs runHiringReviewCheck with email
 * ENABLED. Gated by x-cron-secret; scheduled by migration 0016.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!isValidCronRequest(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const r = await runHiringReviewCheck({ skipEmail: false });
    return NextResponse.json({
      ok: true,
      pendingDocs: r.pendingDocs,
      deferredDocs: r.deferredDocs,
      emailed: r.emailed,
      ...(r.emailError !== undefined ? { emailError: r.emailError } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
