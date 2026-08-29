import { NextResponse } from 'next/server';
import { createServiceClient } from '@/db/clients/service';
import { isValidCronRequest } from '@/server/cron';
import { env } from '@/server/env';
import { servicePoll } from '@/server/wise/service';

// Wise API + service-role client require the Node runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Scheduled Wise reconcile — app-owned (owner decision 2026-08-29; previously
 * the cron path was reserved for the Deno edge function, which was never
 * scheduled in prod). Runs the same servicePoll as the admin "Check statuses"
 * button: draft-only, flips payments to 'sent' on terminal Wise success with
 * Wise's real dates. DRAFT-ONLY money safety — no funding endpoint is ever
 * called. Gated by x-cron-secret.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!isValidCronRequest(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  // Fail fast on a misconfigured deploy (mirrors the edge fn): without a token
  // every transfer lookup lands in 'unknown' and the run would report a bogus
  // markedPaid:0 success while reconciling nothing.
  if (!env.WISE_API_TOKEN) {
    return NextResponse.json(
      { ok: false, error: 'WISE_API_TOKEN not set — cannot reconcile' },
      { status: 500 },
    );
  }
  try {
    const r = await servicePoll(createServiceClient());
    return NextResponse.json({
      ok: true,
      checked: r.checked,
      markedPaid: r.markedPaid,
      inFlight: r.inFlight,
      unknown: r.unknown,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
