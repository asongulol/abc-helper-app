import { redirect } from 'next/navigation';
import { BatchesClient } from '@/components/batches/BatchesClient';
import { createServerSupabase } from '@/db/clients/server';
import { fetchPeriodSummaries } from '@/db/queries/payroll';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getTrackerCompanyId } from '@/server/company';

export const metadata = {
  title: 'Review & Recon Batches — Aaron Anderson E.H.S. LLC',
};

/**
 * Review & Recon Batches (legacy screenshot 09 — ProcessPayroll reconcileOnly).
 * The nav points "Review & Recon Bat…" here. Lists locked/paid batches in a
 * dropdown and shows the Reconciliation overview with a bulk reconcile action.
 */
export default async function BatchesPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getTrackerCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Reconcile with Wise</h2>
        <p className="sub">
          No employer company is configured. Add one in Config (kind = employer).
        </p>
      </div>
    );
  }

  const db = await createServerSupabase();
  const allPeriods = await fetchPeriodSummaries(db, companyId);
  // Dropdown = ALL locked + paid batches (legacy: reconcileOnly period list).
  const periods = allPeriods.filter((p) => p.state === 'locked' || p.state === 'paid');

  return <BatchesClient companyId={companyId} periods={periods} />;
}
