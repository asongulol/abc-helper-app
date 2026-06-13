import { ProcessShell } from '@/components/process/ProcessShell';
import { createServerSupabase } from '@/db/clients/server';
import { fetchPeriodSummaries } from '@/db/queries/payroll';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Process & Pay — ABC Kids HR' };

export default async function ProcessPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Process &amp; Pay</h2>
        <p className="sub">No company selected. Use the company switcher in the header.</p>
      </div>
    );
  }

  const db = await createServerSupabase();
  const allPeriods = await fetchPeriodSummaries(db, companyId);
  // Process screen only shows locked/paid periods
  const periods = allPeriods.filter((p) => p.state === 'locked' || p.state === 'paid');

  return <ProcessShell companyId={companyId} isOwner={admin.isOwner} initialPeriods={periods} />;
}
