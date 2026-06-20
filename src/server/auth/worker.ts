import 'server-only';
import { createServerSupabase } from '@/db/clients/server';

export interface CurrentWorker {
  workerId: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  status: string | null;
  onboarded: boolean;
}

/**
 * Resolve the authenticated contractor via contractor_logins → workers
 * (legacy `my_worker_id()` semantics). RLS-scoped: a contractor only ever
 * reads their own rows.
 */
export const getCurrentWorker = async (): Promise<CurrentWorker | null> => {
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
    status: w.status,
    onboarded: onboarded === true,
  };
};

/** Throwing variant for portal server actions. */
export const requireWorker = async (): Promise<CurrentWorker> => {
  const worker = await getCurrentWorker();
  if (!worker) throw new Error('Not authorized — contractor login required.');
  return worker;
};
