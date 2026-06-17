import { redirect } from 'next/navigation';
import { PayrollShell } from '@/components/payroll/PayrollShell';
import { createServerSupabase } from '@/db/clients/server';
import { fetchPeriodSummaries } from '@/db/queries/payroll';
import { periodFor } from '@/lib/dates/periods';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';

export const metadata = { title: 'Calculate — Aaron Anderson E.H.S. LLC' };

/**
 * Calculate tab (legacy screenshot 07): the calculate / batch-draft workflow.
 * The nav points "Calculate" here. Reuses PayrollShell — the existing client
 * shell that mirrors the legacy Calculate tab (batch list, period picker, draft
 * table, lock / unlock / delete) — rather than duplicating the calc logic.
 */
export default async function CalculatePage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Pay periods ready for calculation</h2>
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
