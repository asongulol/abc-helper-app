import { redirect } from 'next/navigation';
import { BatchesClient } from '@/components/batches/BatchesClient';
import { createServerSupabase } from '@/db/clients/server';
import { listClients } from '@/db/queries/config';
import { fetchPeriodSummaries, fetchRoster } from '@/db/queries/payroll';
import { fullName } from '@/lib/names';
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
  // For attributing a reconcile variance to the client it belongs to.
  const clients = (await listClients(db, { activeOnly: true })).map((c) => ({
    id: c.id,
    name: c.name,
  }));
  // Ended links included on purpose: an outside payment being backfilled is
  // often for a contractor who has since left.
  const roster = (await fetchRoster(db, companyId))
    .map((r) => ({
      workerId: r.workerId,
      name:
        fullName({
          firstName: r.worker.firstName,
          middleName: r.worker.middleName,
          lastName: r.worker.lastName,
        }) || r.workerId,
      payoutMethod: r.worker.payoutMethod,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <BatchesClient companyId={companyId} periods={periods} clients={clients} roster={roster} />
  );
}
