'use client';

/**
 * TimeShell — client-side shell for the /time page.
 * Manages the period picker state, triggers server-component refetches via
 * router.refresh(), and renders the approval table + CSV import card.
 */

import { useRouter } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import { AddSessionForm } from '@/components/sessions/AddSessionForm';
import type { PayPeriod } from '@/lib/dates/periods';
import type { RosterLink } from '@/lib/time/attribution';
import type { ContractorPeriodRow } from '@/lib/time/grouping';
import { CsvImportCard } from './CsvImportCard';
import { PeriodPicker } from './PeriodPicker';
import { TimeApprovalTable } from './TimeApprovalTable';

interface ContractorOption {
  workerId: string;
  displayName: string;
  sourceName: string;
}

interface TimeShellProps {
  companyId: string;
  initialPeriod: PayPeriod;
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
  rows,
  periodDays,
  workingDays,
  unmatchedNames,
  roster,
  contractorOptions,
  assignedClients,
}: TimeShellProps) => {
  const router = useRouter();
  const [period, setPeriod] = useState<PayPeriod>(initialPeriod);
  const [, startRefresh] = useTransition();

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
      setPeriod(p);
      startRefresh(() => router.refresh());
    },
    [router],
  );

  const handleRefresh = useCallback(() => {
    startRefresh(() => router.refresh());
  }, [router]);

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h2 style={{ margin: 0 }}>Time Import &amp; Approval</h2>
            <p className="sub" style={{ marginTop: 4 }}>
              Review, approve, or add manual hours. Approved time flows to Payroll for calculation.
            </p>
          </div>
          <PeriodPicker period={period} onChange={handlePeriodChange} />
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
          onCreated={handleRefresh}
        />
      </div>

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
        <h3 style={{ marginBottom: 12 }}>
          Review &amp; Approve — {period.start} – {period.end}
        </h3>
        <TimeApprovalTable
          companyId={companyId}
          periodStart={period.start}
          periodEnd={period.end}
          periodDays={periodDays}
          workingDays={workingDays}
          rows={rows}
          unmatchedNames={unmatchedNames}
          contractorOptions={contractorOptions}
          assignedClients={assignedClients}
          onRefresh={handleRefresh}
        />
      </div>
    </>
  );
};
