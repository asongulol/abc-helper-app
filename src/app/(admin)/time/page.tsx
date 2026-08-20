import { redirect } from 'next/navigation';
import { TimeShell } from '@/components/time/TimeShell';
import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import { fetchHolidaysConfig } from '@/db/queries/holidays';
import { fetchWorkerClientsBatch } from '@/db/queries/sessions';
import {
  countPendingOutside,
  fetchContractorOptions,
  fetchLastImportedDate,
  fetchPeriodEntries,
  fetchRosterLinks,
  fetchUnpaidEntries,
} from '@/db/queries/time';
import { nextUnimportedPeriod, periodFor } from '@/lib/dates/periods';
import { expectedHours } from '@/lib/pay/expected-hours';
import { resolveHolidaysForRange } from '@/lib/pay/holidays';
import { buildMatchIndex, matchName } from '@/lib/time/attribution';
import { groupByContractor, periodStats } from '@/lib/time/grouping';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getTrackerCompanyId } from '@/server/company';

export const metadata = { title: 'Time Import — Aaron Anderson E.H.S. LLC' };

export default async function TimePage({
  searchParams,
}: {
  searchParams: Promise<{ start?: string; end?: string; unpaid?: string }>;
}) {
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

  const sp = await searchParams;
  const isIsoDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const unpaidMode = sp.unpaid === '1';
  const today = new Date().toISOString().slice(0, 10);

  const db = await createServerSupabase();

  // Default review period = the NEXT UNIMPORTED one: this page's job is getting
  // the next batch of hours in, so it lands on the period the import will cover
  // (last import through 7/15 → 7/16-7/31). Falls back to the arrears period on
  // an empty company. An explicit ?start= deep-link (period picker) overrides;
  // periodFor reconstitutes end+payDate and throws on malformed input.
  const period = isIsoDate(sp.start)
    ? periodFor(sp.start)
    : nextUnimportedPeriod(await fetchLastImportedDate(db, companyId), today);

  const [entries, roster, contractorOptions, holidaysConfig, pendingElsewhere] = await Promise.all([
    unpaidMode
      ? fetchUnpaidEntries(db, companyId)
      : fetchPeriodEntries(db, companyId, period.start, period.end),
    fetchRosterLinks(db, companyId),
    fetchContractorOptions(db, companyId),
    fetchHolidaysConfig(db, companyId),
    // The unpaid view already spans every period, so the pointer to it is
    // only worth counting in period view.
    unpaidMode ? 0 : countPendingOutside(db, companyId, period.start, period.end),
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
  const holidays = resolveHolidaysForRange(holidaysConfig, period.start, period.end);
  const stats = periodStats(period.start, period.end, holidays);

  // Expected hours per worker for THIS period (working days × contracted
  // day-hours). Per-unit contracts (PH/PS/PHS) have none and are omitted —
  // the table shows "—" for them. Period-scoped, so skipped in unpaid mode.
  const expectedByWorker: Record<string, number> = {};
  if (!unpaidMode) {
    for (const r of roster) {
      const h = expectedHours(r.contract ?? 'FT', period.start, period.end, holidays);
      if (h > 0) expectedByWorker[r.workerId] = h;
    }
  }

  // Find source_names (from the shown entries) with no matching worker.
  const idx = buildMatchIndex(roster);
  const sourceNames = [...new Set(entries.map((e) => e.sourceName))];
  const unmatchedNames = sourceNames.filter((name) => matchName(name, idx) === null);

  return (
    <TimeShell
      companyId={companyId}
      initialPeriod={period}
      unpaidMode={unpaidMode}
      rows={rows}
      periodDays={stats.periodDays}
      workingDays={stats.workingDays}
      unmatchedNames={unmatchedNames}
      pendingElsewhere={pendingElsewhere}
      roster={roster}
      contractorOptions={contractorOptions}
      assignedClients={assignedClients}
      expectedByWorker={expectedByWorker}
    />
  );
}
