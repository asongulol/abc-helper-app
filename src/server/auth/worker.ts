import 'server-only';
import { cache } from 'react';
import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import { hasPayOutstanding } from '@/db/queries/workers';

export interface CurrentWorker {
  workerId: string;
  userId: string;
  firstName: string;
  lastName: string;
  /** Email on the workers record (HR data; may differ from the login email). */
  email: string | null;
  /** Supabase Auth login email — what the contractor signs in with. */
  authEmail: string | null;
  status: string | null;
  onboarded: boolean;
}

/**
 * `accessEnded` separates "this user is not a contractor" from "this contractor
 * has left and been paid" — both deny, but only the second is worth explaining
 * on the login page. Deliberately one shape rather than a union: every caller
 * still gates on `worker` alone, so a new denial reason can never be read as
 * a pass.
 */
type Resolution = { worker: CurrentWorker | null; accessEnded: boolean };

/**
 * Resolve the authenticated contractor via contractor_logins → workers
 * (legacy `my_worker_id()` semantics). RLS-scoped: a contractor only ever
 * reads their own rows.
 *
 * Wrapped in React `cache()` (the portal mirror of getCurrentAdmin): the portal
 * layout, the page, and any requireWorker call in one request now share a single
 * getUser + contractor_logins + workers + is_onboarded chain instead of repeating
 * all four round-trips 2-3× per portal navigation. Per-request scope re-verifies
 * on every new request, so no auth state leaks across requests.
 */
const resolve = cache(async (): Promise<Resolution> => {
  const denied = { worker: null, accessEnded: false };
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return denied;

  // Anything but `status='active'` denies, mirroring the RLS helper
  // my_worker_id() exactly — but the status is READ rather than filtered on, so
  // a revoked login can still be told apart from "not a contractor at all".
  // Since #85 that revocation is what ends access (nightly sunset sweep), and
  // without the distinction the login page reads as a rejected password.
  const { data: login } = await supabase
    .from('contractor_logins')
    .select('worker_id, status')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (!login) return denied;

  if (login.status !== 'active') {
    // Their own workers row is no longer readable — `workers_contractor_read` is
    // keyed on my_worker_id(), which a revoked login does not resolve — so the
    // service client answers the only question left: was this a departure (say
    // so) or an admin pulling access for cause (stay generic)?
    const { data: gone } = await createServiceClient()
      .from('workers')
      .select('status')
      .eq('id', login.worker_id)
      .maybeSingle();
    return { worker: null, accessEnded: gone?.status === 'ended' };
  }

  const { data: w } = await supabase
    .from('workers')
    .select('id, first_name, last_name, email, status')
    .eq('id', login.worker_id)
    .maybeSingle();
  if (!w) return denied;

  // Departure does not revoke the login — terminateContractor leaves it alone on
  // purpose — so access ends only once the money has actually landed. Someone who
  // left last week still needs their payslips. Only 'ended' workers pay for the
  // check; for everyone else this is a status comparison and no extra round-trip.
  //
  // The revocation that RLS honours is the nightly sweep's (sunsetPortalLogins,
  // #85): this app's resolver cannot be the enforcement point, because the client
  // that keeps the access is the legacy portal, which never runs any of this.
  // Keeping the check here anyway closes the ≤24h window before the next tick,
  // for the one client that does run it.
  //
  // A rehire in progress is the one departure that keeps access while fully
  // paid: sendContractVersion restored the login so they can sign, and the
  // engagement stays 'ended' until countersign. Same rule as the sweep's skip.
  if (w.status === 'ended') {
    const svc = createServiceClient();
    const { data: rehiring } = await svc
      .from('contract_versions')
      .select('id')
      .eq('worker_id', w.id)
      .in('status', ['sent', 'signed'])
      .limit(1)
      .maybeSingle();
    if (!rehiring && !(await hasPayOutstanding(svc, w.id))) {
      return { worker: null, accessEnded: true };
    }
  }

  // Legacy RLS helper: true once the contractor finished onboarding.
  const { data: onboarded } = await supabase.rpc('is_onboarded');

  return {
    worker: {
      workerId: w.id,
      userId: user.id,
      firstName: w.first_name,
      lastName: w.last_name,
      email: w.email,
      authEmail: user.email ?? null,
      status: w.status,
      onboarded: onboarded === true,
    },
    accessEnded: false,
  };
});

export const getCurrentWorker = async (): Promise<CurrentWorker | null> => (await resolve()).worker;

/**
 * True when the signed-in user IS a contractor whose portal access has ended.
 * Only the login page needs this: without it a denied sign-in bounces
 * /portal → /portal/login and reads as a wrong password.
 */
export const portalAccessEnded = async (): Promise<boolean> => (await resolve()).accessEnded;

/** Throwing variant for portal server actions. */
export const requireWorker = async (): Promise<CurrentWorker> => {
  const worker = await getCurrentWorker();
  if (!worker) throw new Error('Not authorized — contractor login required.');
  return worker;
};
