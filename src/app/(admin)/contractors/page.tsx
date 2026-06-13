import { ContractorsClient } from '@/components/contractors/ContractorsClient';
import { createServerSupabase } from '@/db/clients/server';
import { fetchRates } from '@/db/queries/payroll';
import { fetchRoster } from '@/db/queries/workers';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Contractors — ABC Kids HR' };

export default async function ContractorsPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Contractors</h2>
        <p className="sub">No company selected or accessible. Please contact the owner.</p>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const db = await createServerSupabase();

  const [roster, allRates] = await Promise.all([
    fetchRoster(db, companyId),
    fetchRates(db, companyId),
  ]);

  return (
    <ContractorsClient companyId={companyId} roster={roster} allRates={allRates} today={today} />
  );
}
