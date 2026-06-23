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
 * Admin decrypt of a worker's stored tool credentials via the
 * `decrypt_worker_tools` RPC (admin-authorized, service-role). PERSISTENT — the
 * ciphertext is NOT purged, so the same credentials can be re-read. This matches
 * the shared-prod / live-app model: abc-helper-app's former one-time-purge
 * `reveal_worker_tools` would have deleted credentials that the original apps
 * (sharing this DB and `worker_tools.enc`) still need to re-read. Returns null
 * when nothing is provisioned or the call fails.
 */
export const decryptWorkerTools = async (
  svc: ServiceClient,
  workerId: string,
): Promise<Json | null> => {
  try {
    const { data, error } = await svc.rpc('decrypt_worker_tools', {
      p_worker_id: workerId,
    });
    if (error || data === null || data === undefined) return null;
    return data;
  } catch {
    return null;
  }
};
