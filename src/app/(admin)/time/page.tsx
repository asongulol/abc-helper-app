import { redirect } from 'next/navigation';
import { TimeShell } from '@/components/time/TimeShell';
import { createServerSupabase } from '@/db/clients/server';
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
import { getSelectedCompanyId } from '@/server/company';

export const metadata = { title: 'Time Import — Aaron Anderson E.H.S. LLC' };

export default async function TimePage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Time Import</h2>
        <p className="sub">No company selected. Please contact the owner.</p>
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
    />
  );
}
