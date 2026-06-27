import { redirect } from 'next/navigation';
import { TimeShell } from '@/components/time/TimeShell';
import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import { fetchWorkerClientsBatch } from '@/db/queries/sessions';
import {
  fetchContractorOptions,
  fetchPeriodEntries,
  fetchRosterLinks,
  fetchSourceNames,
} from '@/db/queries/time';
import { periodFor } from '@/lib/dates/periods';
import { buildMatchIndex, matchName } from '@/lib/time/attribution';
import { groupByContractor, periodStats } from '@/lib/time/grouping';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getTrackerCompanyId } from '@/server/company';

export const metadata = { title: 'Time Import — Aaron Anderson E.H.S. LLC' };

export default async function TimePage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getTrackerCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Time Import</h2>
        <p className="sub">
          No employer company is configured. Add one in Config (kind = employer).
        </p>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const period = periodFor(today);

  const db = await createServerSupabase();

  const [entries, roster, contractorOptions, sourceNamesInPeriod] = await Promise.all([
    fetchPeriodEntries(db, companyId, period.start, period.end),
    fetchRosterLinks(db, companyId),
    fetchContractorOptions(db, companyId),
    fetchSourceNames(db, companyId, period.start, period.end),
  ]);

  // Each contractor's assigned CLIENT(s) — the invoicing target. Shown per row;
  // none / multiple is flagged as ambiguous (per-project attribution needed).
  const clientsByWorker = await fetchWorkerClientsBatch(
    createServiceClient(),
    roster.map((r) => r.workerId),
  );
  const assignedClients: Record<string, { id: string; name: string }[]> = {};
  for (const [workerId, list] of clientsByWorker) assignedClients[workerId] = list;

  const rows = groupByContractor(entries);
  const stats = periodStats(period.start, period.end);

  // Find source_names with no matching worker.
  const idx = buildMatchIndex(roster);
  const unmatchedNames = sourceNamesInPeriod.filter((name) => matchName(name, idx) === null);

  return (
    <TimeShell
      companyId={companyId}
      initialPeriod={period}
      rows={rows}
      periodDays={stats.periodDays}
      workingDays={stats.workingDays}
      unmatchedNames={unmatchedNames}
      roster={roster}
      contractorOptions={contractorOptions}
      assignedClients={assignedClients}
    />
  );
}
