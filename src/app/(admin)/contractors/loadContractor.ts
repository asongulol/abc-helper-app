import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/db/clients/server';
import type { RosterWorker } from '@/db/queries/workers';
import { fetchWorkerLink } from '@/db/queries/workers';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId, listCompanies } from '@/server/company';

export interface ContractorPageData {
  worker: RosterWorker;
  companyId: string;
  companyName: string;
  companies: { id: string; name: string }[];
}

/**
 * Loads a single contractor (worker_companies link) for the selected company,
 * shared by the full-page route and its intercept-modal counterpart. Redirects
 * to login when not an admin; returns null when the worker isn't in the
 * selected company (caller renders notFound()).
 */
export async function loadContractor(workerId: string): Promise<ContractorPageData | null> {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) return null;

  const db = await createServerSupabase();
  const [worker, companies] = await Promise.all([
    fetchWorkerLink(db, workerId, companyId),
    listCompanies(),
  ]);
  if (!worker) return null;

  return {
    worker,
    companyId,
    companyName: companies.find((c) => c.id === companyId)?.name ?? '',
    companies,
  };
}
