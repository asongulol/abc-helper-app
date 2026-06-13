'use client';

import type { Database } from '@/db/types';
import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser Supabase client (RLS applies). Client components only — e.g. starting
 * the Google OAuth flow or realtime subscriptions. Public anon config only.
 */
export const createBrowserSupabase = () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  return createBrowserClient<Database>(url, anonKey);
};
