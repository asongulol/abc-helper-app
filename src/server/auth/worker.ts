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

  // `status='active'` mirrors the RLS helper my_worker_id() exactly: a revoked/
  // deactivated login must resolve to no worker, so every portal path (including
  // service-role writes that bypass RLS) denies it.
  const { data: login } = await supabase
    .from('contractor_logins')
    .select('worker_id')
    .eq('auth_user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();
  if (!login) return denied;

  const { data: w } = await supabase
    .from('workers')
    .select('id, first_name, last_name, email, status')
    .eq('id', login.worker_id)
    .maybeSingle();
  if (!w) return denied;

  // Departure does not revoke the login — terminateContractor leaves it alone on
  // purpose, so the end of access is decided HERE, at sign-in, and only once the
  // money has actually landed. Someone who left last week still needs their
  // payslips. Only 'ended' workers pay for the check; for everyone else this is
  // a status comparison and no extra round-trip.
  if (w.status === 'ended' && !(await hasPayOutstanding(createServiceClient(), w.id))) {
    return { worker: null, accessEnded: true };
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
