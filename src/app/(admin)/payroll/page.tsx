import { PayrollShell } from '@/components/payroll/PayrollShell';
import { createServerSupabase } from '@/db/clients/server';
import { fetchPeriodSummaries } from '@/db/queries/payroll';
import { periodFor } from '@/lib/dates/periods';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Payroll — ABC Kids HR' };

export default async function PayrollPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Payroll</h2>
        <p className="sub">No company selected. Use the company switcher in the header.</p>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const defaultPeriod = periodFor(today);

  const db = await createServerSupabase();
  const periods = await fetchPeriodSummaries(db, companyId);

  return (
    <PayrollShell
      companyId={companyId}
      isOwner={admin.isOwner}
      defaultPeriod={defaultPeriod}
      initialPeriods={periods}
    />
  );
}
