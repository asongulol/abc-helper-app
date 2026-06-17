import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/db/types';

type ServiceClient = SupabaseClient<Database>;

/**
 * Read a single value from the app_secrets table (key→value store).
 * Returns '' if the key does not exist or the read fails.
 */
export const getAppSecret = async (svc: ServiceClient, key: string): Promise<string> => {
  try {
    const { data } = await svc.from('app_secrets').select('value').eq('key', key).maybeSingle();
    return data?.value ?? '';
  } catch {
    return '';
  }
};

/**
 * ONE-TIME reveal of a worker's stored tool credentials via the
 * `reveal_worker_tools` RPC (admin-authorized, service-role). The RPC decrypts
 * and then permanently purges the stored ciphertext, so this succeeds at most
 * once per provisioning. Returns null when nothing is stored, it was already
 * revealed, or the call fails. To re-deliver, re-provision via `set_worker_tools`.
 */
export const revealWorkerToolsOnce = async (
  svc: ServiceClient,
  workerId: string,
): Promise<Json | null> => {
  try {
    const { data, error } = await svc.rpc('reveal_worker_tools', {
      p_worker_id: workerId,
    });
    if (error || data === null || data === undefined) return null;
    return data;
  } catch {
    return null;
  }
};
