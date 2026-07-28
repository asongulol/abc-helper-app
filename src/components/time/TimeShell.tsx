'use client';

/**
 * TimeShell — client-side shell for the /time page.
 * Manages the period picker state, triggers server-component refetches via
 * router.refresh(), and renders the approval table + CSV import card.
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import { AddSessionForm } from '@/components/sessions/AddSessionForm';
import type { PayPeriod } from '@/lib/dates/periods';
import type { RosterLink } from '@/lib/time/attribution';
import type { ContractorPeriodRow } from '@/lib/time/grouping';
import { CsvImportCard } from './CsvImportCard';
import { OffCycleCatchUpCard } from './OffCycleCatchUpCard';
import { PeriodPicker } from './PeriodPicker';
import { TimeApprovalTable } from './TimeApprovalTable';

interface ContractorOption {
  workerId: string;
  displayName: string;
  sourceName: string;
}

/**
 * Review-header state. "empty" (nothing imported yet) is NOT "all approved" —
 * showing "all clear" before a sync has run is what RP-42 flagged.
 */
export const reviewStatus = (
  entryCount: number,
  pendingCount: number,
): 'empty' | 'pending' | 'clear' =>
  entryCount === 0 ? 'empty' : pendingCount > 0 ? 'pending' : 'clear';

/** /time URL that keeps the picked period across the "all unpaid" toggle (RP-51). */
export const timeHref = (pathname: string, period: PayPeriod, unpaid: boolean): string =>
  `${pathname}?start=${period.start}&end=${period.end}${unpaid ? '&unpaid=1' : ''}`;

interface TimeShellProps {
  companyId: string;
  initialPeriod: PayPeriod;
  /** Cross-period "all unpaid" view: entries span periods, coverage is hidden. */
  unpaidMode: boolean;
  rows: ContractorPeriodRow[];
  periodDays: number;
  workingDays: number;
  unmatchedNames: string[];
  roster: RosterLink[];
  contractorOptions: ContractorOption[];
  /** worker_id → assigned active CLIENT companies (the invoicing target). */
  assignedClients: Record<string, { id: string; name: string }[]>;
}

export const TimeShell = ({
  companyId,
  initialPeriod,
  unpaidMode,
  rows,
  periodDays,
  workingDays,
  unmatchedNames,
  roster,
  contractorOptions,
  assignedClients,
}: TimeShellProps) => {
  const router = useRouter();
  const pathname = usePathname();
  // Server resolves the period from the URL (?start=) — it's the source of truth.
  const period = initialPeriod;
  const [navPending, startRefresh] = useTransition();
  // The Review & Approve grid is collapsed by default so it isn't distracting
  // and you can't accidentally act on the wrong period — expand to review.
  const [reviewOpen, setReviewOpen] = useState(false);
  // Bumped on every refresh so client-fetching children re-run their effect —
  // router.refresh() only re-renders server components (RP-47).
  const [refreshKey, setRefreshKey] = useState(0);
  const entries = rows.flatMap((r) => r.entries);
  const pendingCount = entries.filter((e) => e.approval === 'pending').length;
  const status = reviewStatus(entries.length, pendingCount);

  // Contractors whose hours can't be cleanly invoiced: no client, or more than
  // one (multi-client needs per-project attribution — see the hours plan).
  const ambiguous = rows
    .filter((r) => r.workerId)
    .map((r) => ({
      name: r.sourceName,
      count: (assignedClients[r.workerId as string] ?? []).length,
    }))
    .filter((x) => x.count !== 1);

  const handlePeriodChange = useCallback(
    (p: PayPeriod) => {
      startRefresh(() => router.push(`?start=${p.start}&end=${p.end}`));
    },
    [router],
  );

  const toggleUnpaid = useCallback(() => {
    startRefresh(() => router.push(timeHref(pathname, period, !unpaidMode)));
  }, [router, unpaidMode, pathname, period]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    startRefresh(() => router.refresh());
  }, [router]);

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head" style={{ marginBottom: 0 }}>
          <div>
            <h2>Time Import &amp; Approval</h2>
            <p className="sub">
              Review, approve, or add manual hours. Approved time flows to Payroll for calculation.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {/* Disabled while the navigation is in flight — a second click on
                Prev would otherwise skip a period and you'd approve the wrong
                one's hours (RP-41). */}
            {!unpaidMode && (
              <PeriodPicker period={period} onChange={handlePeriodChange} disabled={navPending} />
            )}
            <button
              type="button"
              className={unpaidMode ? 'btn sm' : 'btn ghost sm'}
              onClick={toggleUnpaid}
              disabled={navPending}
              aria-busy={navPending}
            >
              {unpaidMode ? '← Back to period view' : 'Show all unpaid'}
            </button>
          </div>
        </div>
      </div>

      <CsvImportCard companyId={companyId} roster={roster} onImported={handleRefresh} />

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 4 }}>Add a session (per-session contractors)</h3>
        <p className="sub" style={{ marginTop: 0, marginBottom: 12 }}>
          Record an Early-Intervention session — same fields the contractor enters in their portal.
          The client is required (it's the company billed). The date can fall in any period.
        </p>
        <AddSessionForm
          companyId={companyId}
          defaultDate={period.start}
          periodStart={period.start}
          periodEnd={period.end}
          unpaidMode={unpaidMode}
          onCreated={handleRefresh}
        />
      </div>

      {/* Salaried leftovers on a locked/paid period → off-cycle batch. Renders
          nothing while the viewed period is open or has no FT/PT leftovers. */}
      <OffCycleCatchUpCard
        companyId={companyId}
        periodStart={period.start}
        refreshKey={refreshKey}
      />

      {ambiguous.length > 0 && (
        <div
          className="card"
          style={{ marginTop: 16, borderColor: 'var(--warn)', background: 'var(--warn-soft)' }}
        >
          <p className="sub" style={{ margin: 0 }}>
            ⚠ {ambiguous.length} contractor(s) can&apos;t be cleanly invoiced — each needs exactly{' '}
            <b>one</b> assigned client (hours bill to that client). Fix on the contractor&apos;s Pay
            tab, or set up per-project attribution for multi-client contractors:{' '}
            {ambiguous
              .map((a) => `${a.name} (${a.count === 0 ? 'no client' : `${a.count} clients`})`)
              .join(', ')}
            .
          </p>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ margin: 0 }}>
          <button
            type="button"
            onClick={() => setReviewOpen((o) => !o)}
            aria-expanded={reviewOpen}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
              background: 'none',
              border: 'none',
              padding: 0,
              font: 'inherit',
              color: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span aria-hidden style={{ color: 'var(--muted)', fontSize: '0.85em' }}>
                {reviewOpen ? '▾' : '▸'}
              </span>
              Review &amp; Approve —{' '}
              {unpaidMode ? 'all unpaid periods' : `${period.start} – ${period.end}`}
            </span>
            <span className="sub" style={{ margin: 0, fontWeight: 400, fontSize: 13 }}>
              {status === 'empty'
                ? 'no entries yet'
                : status === 'pending'
                  ? `${pendingCount} pending`
                  : 'all approved'}
              {reviewOpen ? '' : ' · click to review'}
            </span>
          </button>
        </h3>
        {/* The onward step once nothing is pending. Outside the <button> — a
            link nested in a button is invalid HTML. */}
        {status === 'clear' && !unpaidMode && (
          <p className="sub" style={{ margin: '8px 0 0' }}>
            All {entries.length} entr{entries.length === 1 ? 'y' : 'ies'} approved —{' '}
            <Link href={`/payroll?period=${period.start}`}>
              calculate payroll for this period →
            </Link>
          </p>
        )}
        {status === 'empty' && (
          <p className="sub" style={{ margin: '8px 0 0' }}>
            Nothing imported for this period yet — upload a CSV or sync from Hubstaff above.
          </p>
        )}
        {reviewOpen && (
          <div style={{ marginTop: 12 }}>
            <TimeApprovalTable
              companyId={companyId}
              periodStart={period.start}
              periodEnd={period.end}
              periodDays={periodDays}
              workingDays={workingDays}
              coverageHidden={unpaidMode}
              rows={rows}
              unmatchedNames={unmatchedNames}
              contractorOptions={contractorOptions}
              assignedClients={assignedClients}
              onRefresh={handleRefresh}
            />
          </div>
        )}
      </div>
    </>
  );
};
