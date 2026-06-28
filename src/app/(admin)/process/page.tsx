import { redirect } from 'next/navigation';
import { ProcessPay } from '@/components/process/ProcessPay';
import { ProcessShell } from '@/components/process/ProcessShell';
import { createServerSupabase } from '@/db/clients/server';
import { countPendingTimeApprovals } from '@/db/queries/overview';
import { fetchPeriodSummaries } from '@/db/queries/payroll';
import { getProcessPayments } from '@/server/actions/payroll';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getTrackerCompanyId } from '@/server/company';

export const metadata = {
  title: 'Process payroll — Aaron Anderson E.H.S. LLC',
};

export default async function ProcessPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
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
  const { period: periodId } = await searchParams;
  const allPeriods = await fetchPeriodSummaries(db, companyId);

  // Detail view: a specific locked/paid batch → the pay-execution panel.
  if (periodId) {
    const period = allPeriods.find((p) => p.id === periodId);
    if (period && (period.state === 'locked' || period.state === 'paid')) {
      const res = await getProcessPayments({ periodId: period.id, companyId });
      return (
        <ProcessPay
          period={{
            id: period.id,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            payDate: period.payDate,
            state: period.state,
            kind: period.kind,
          }}
          companyId={companyId}
          initialPayments={res.ok ? res.data.payments : []}
          isOwner={admin.isOwner}
        />
      );
    }
    // Not found / not payable → fall through to the list.
  }

  const pending = await countPendingTimeApprovals(db, companyId);

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
