import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { createServerSupabase } from '@/db/clients/server';
import type { Database } from '@/db/types';
import { env } from '@/server/env';

/** Cookie holding the admin's selected company (legacy: company switcher). */
export const COMPANY_COOKIE = 'abc_company';

/** Cookie holding the header CLIENT filter: comma-joined client company ids; absent/empty = all. */
export const CLIENTS_COOKIE = 'abc_clients';

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
  kind: string;
}

/**
 * Companies visible to the current admin (RLS does the scoping).
 *
 * Wrapped in React `cache()`: `getSelectedCompanyId` (34 call sites) plus the
 * layout and pages all funnel through here, so without memoization the
 * `companies` query ran 4-5× per page load. Now it runs once per request.
 */
export const listCompanies = cache(async (): Promise<CompanyOption[]> => {
  const supabase = await createServerSupabase();
  const { data } = await supabase.from('companies').select('id, name, kind').order('name');
  return data ?? [];
});

/**
 * The header CLIENT filter — client company ids the admin picked, validated
 * against the visible client companies (stale/foreign ids are dropped).
 * Empty array = no filter (all clients + internal staff). Memoized per request.
 */
export const getSelectedClientIds = cache(async (): Promise<string[]> => {
  const raw = (await cookies()).get(CLIENTS_COOKIE)?.value ?? '';
  if (!raw) return [];
  const clients = new Set(
    (await listCompanies()).filter((c) => c.kind === 'client').map((c) => c.id),
  );
  return raw.split(',').filter((id) => clients.has(id));
});

/**
 * The company every ADMIN page operates on — ALWAYS the single EMPLOYER
 * (Aaron Anderson E.H.S. LLC). This is a single-employer deployment: contractors
 * work for the employer; clients (Ability Builders, 123 Baby Talks, …) are
 * billing tags surfaced only in Invoicing + per-entry pickers, never as a
 * payroll/admin context. The switcher cookie is intentionally ignored so no
 * admin page can land on a client. Falls back to the first company only on a
 * fresh DB with no employer row yet. Memoized per request.
 */
export const getSelectedCompanyId = cache(async (): Promise<string | null> => {
  const db = await createServerSupabase();
  const employerId = await getEmployerCompanyId(db);
  if (employerId) return employerId;
  const companies = await listCompanies();
  return companies[0]?.id ?? null;
});

/** Alias kept for the payroll tracker call sites — same employer-only resolution. */
export const getTrackerCompanyId = getSelectedCompanyId;
