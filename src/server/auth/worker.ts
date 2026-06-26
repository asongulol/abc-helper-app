import 'server-only';
import { cache } from 'react';
import { createServerSupabase } from '@/db/clients/server';

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
export const getCurrentWorker = cache(async (): Promise<CurrentWorker | null> => {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // `status='active'` mirrors the RLS helper my_worker_id() exactly: a revoked/
  // deactivated login must resolve to no worker, so every portal path (including
  // service-role writes that bypass RLS) denies it.
  const { data: login } = await supabase
    .from('contractor_logins')
    .select('worker_id')
    .eq('auth_user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();
  if (!login) return null;

  const { data: w } = await supabase
    .from('workers')
    .select('id, first_name, last_name, email, status')
    .eq('id', login.worker_id)
    .maybeSingle();
  if (!w) return null;

  // Legacy RLS helper: true once the contractor finished onboarding.
  const { data: onboarded } = await supabase.rpc('is_onboarded');

  return {
    workerId: w.id,
    userId: user.id,
    firstName: w.first_name,
    lastName: w.last_name,
    email: w.email,
    authEmail: user.email ?? null,
    status: w.status,
    onboarded: onboarded === true,
  };
});

/** Throwing variant for portal server actions. */
export const requireWorker = async (): Promise<CurrentWorker> => {
  const worker = await getCurrentWorker();
  if (!worker) throw new Error('Not authorized — contractor login required.');
  return worker;
};
