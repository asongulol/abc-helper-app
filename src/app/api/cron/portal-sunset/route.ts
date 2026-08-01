import { NextResponse } from 'next/server';
import { createServiceClient } from '@/db/clients/service';
import { sunsetPortalLogins } from '@/db/queries/workers';
import { isValidCronRequest } from '@/server/cron';

// Service-role client requires the Node runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Nightly portal-access sunset (#85). Revokes the login of every departed
 * contractor whose pay has landed, so RLS — not just this app's resolver —
 * enforces the end of access. Gated by x-cron-secret; scheduled by migration
 * 0039.
 *
 * Service client: `contractor_logins` is SELECT-only under RLS, and
 * `hasPayOutstanding` reads admin-only `worker_companies`.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!isValidCronRequest(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const r = await sunsetPortalLogins(createServiceClient());
    return NextResponse.json({ ok: true, checked: r.checked, revoked: r.revoked.length });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
