import 'server-only';

import type { Database, Json } from '@/db/types';
import type { SupabaseClient } from '@supabase/supabase-js';

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
 * Decrypt the stored tool credentials for a worker via the `decrypt_worker_tools`
 * RPC (service-role only). Returns null when no credentials are stored or the
 * RPC call fails.
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
