import 'server-only';
import { createServerSupabase } from '@/db/clients/server';
import type { Database } from '@/db/types';
import { env } from '@/server/env';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

/** Cookie holding the admin's selected company (legacy: company switcher). */
export const COMPANY_COOKIE = 'abc_company';

/**
 * The single EMPLOYER company id (companies.kind='employer'). Contractors are
 * attributed to the employer (Aaron Anderson E.H.S. LLC); clients (Ability
 * Builders, 123 Baby Talks) are billing tags. So onboarding docs/time belong to
 * the employer. EMPLOYER_COMPANY_ID overrides; mirrors the hubstaff-sync edge fn.
 * Caller passes the client (use a service client to bypass RLS).
 */
export const getEmployerCompanyId = async (
  db: SupabaseClient<Database>,
): Promise<string | null> => {
  if (env.EMPLOYER_COMPANY_ID) return env.EMPLOYER_COMPANY_ID.trim();
  const { data } = await db
    .from('companies')
    .select('id')
    .eq('kind', 'employer')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
};

export interface CompanyOption {
  id: string;
  name: string;
}

/** Companies visible to the current admin (RLS does the scoping). */
export const listCompanies = async (): Promise<CompanyOption[]> => {
  const supabase = await createServerSupabase();
  const { data } = await supabase.from('companies').select('id, name').order('name');
  return data ?? [];
};

/**
 * The selected company id, defaulting to the first visible company. Server
 * Components read this; the switcher (server action) writes the cookie.
 */
export const getSelectedCompanyId = async (): Promise<string | null> => {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(COMPANY_COOKIE)?.value;
  const companies = await listCompanies();
  if (fromCookie && companies.some((c) => c.id === fromCookie)) return fromCookie;
  return companies[0]?.id ?? null;
};
