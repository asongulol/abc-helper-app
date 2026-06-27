import { redirect } from 'next/navigation';
import { ProcessShell } from '@/components/process/ProcessShell';
import { createServerSupabase } from '@/db/clients/server';
import { countPendingTimeApprovals } from '@/db/queries/overview';
import { fetchPeriodSummaries } from '@/db/queries/payroll';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getTrackerCompanyId } from '@/server/company';

export const metadata = {
  title: 'Process payroll — Aaron Anderson E.H.S. LLC',
};

export default async function ProcessPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getTrackerCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Process payroll</h2>
        <p className="sub">
          No employer company is configured. Add one in Config (kind = employer).
        </p>
      </div>
    );
  }

  const db = await createServerSupabase();
  // Independent reads — run concurrently instead of as a serial waterfall.
  const [allPeriods, pending] = await Promise.all([
    fetchPeriodSummaries(db, companyId),
    countPendingTimeApprovals(db, companyId),
  ]);

  // Legacy "Process payroll": a LIST of locked-but-not-yet-paid batches.
  const ready = allPeriods.filter((p) => p.state === 'locked');

  // Waiting-upstream prep (legacy `prep`): OPEN periods that actually have
  // payment rows (real calculated drafts), plus the count of pending time
  // entries in Time & Approval. Empty open periods are NOT counted.
  const drafts = allPeriods
    .filter((p) => p.state === 'open' && p.contractorCount > 0)
    .map((p) => ({ start: p.periodStart, end: p.periodEnd }))
    .sort((a, b) => (b.start || '').localeCompare(a.start || ''));

  return <ProcessShell ready={ready} drafts={drafts} pending={pending} />;
}
