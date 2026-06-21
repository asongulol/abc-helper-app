import { NextResponse } from 'next/server';
import { isValidCronRequest } from '@/server/cron';
import { runExpiryCheck } from '@/server/documents/service';

// nodemailer (email digest) + the service-role client require the Node runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Scheduled document-expiry digest. Runs runExpiryCheck with email ENABLED
 * (the on-demand admin action runs it with skipEmail). Gated by x-cron-secret;
 * scheduled by migration 0016. Closes the "expiry is display-on-demand only" gap.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!isValidCronRequest(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const r = await runExpiryCheck({ skipEmail: false });
    return NextResponse.json({
      ok: true,
      overdue: r.overdue.length,
      expiringSoon: r.expiringSoon.length,
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
