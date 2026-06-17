import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';
import { env } from '@/server/env';

/**
 * Service-role Supabase client — **bypasses Row Level Security**.
 *
 * Use ONLY inside server actions / cron route handlers, ONLY after the caller's
 * identity and role have been independently verified (or the cron secret
 * checked). `server-only` makes a client-bundle import a build error.
 */

let cached: SupabaseClient<Database> | null = null;

export const createServiceClient = (): SupabaseClient<Database> => {
  if (cached) return cached;
  cached = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
};
