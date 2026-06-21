import { NextResponse } from 'next/server';
import { isValidCronRequest } from '@/server/cron';
import { runScheduledHiringReviewDigest } from '@/server/documents/service';

// nodemailer (email digest) + the service-role client require the Node runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Scheduled hiring-docs-review digest. Honors the admin's `reminders` config
 * (enabled / frequency / send_to / include_deferred): the cron fires daily,
 * this route decides whether today actually emails and to whom.
 * Gated by x-cron-secret; scheduled by migration 0016.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!isValidCronRequest(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const r = await runScheduledHiringReviewDigest();
    if (!r.ran || !r.result) {
      return NextResponse.json({ ok: true, skipped: true, reason: r.skippedReason });
    }
    return NextResponse.json({
      ok: true,
      pendingDocs: r.result.pendingDocs,
      deferredDocs: r.result.deferredDocs,
      emailed: r.result.emailed,
      ...(r.result.emailError !== undefined ? { emailError: r.result.emailError } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
