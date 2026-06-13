import 'server-only';
import { createServerSupabase } from '@/db/clients/server';
import { cookies } from 'next/headers';

/** Cookie holding the admin's selected company (legacy: company switcher). */
export const COMPANY_COOKIE = 'abc_company';

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
