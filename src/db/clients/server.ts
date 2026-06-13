import 'server-only';
import type { Database } from '@/db/types';
import { env } from '@/server/env';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Request-scoped Supabase client backed by the auth cookie (RLS applies).
 * The "user client" of the two-client model (ADR-0004); privileged work uses
 * the service client behind an explicit role check.
 */
export const createServerSupabase = async () => {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Component (read-only cookies) — middleware handles refresh.
          }
        },
      },
    },
  );
};
