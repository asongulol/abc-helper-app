'use client';

/**
 * TimeShell — client-side shell for the /time page.
 * Manages the period picker state, triggers server-component refetches via
 * router.refresh(), and renders the approval table + CSV import card.
 */

import { useRouter } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
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
}: TimeShellProps) => {
  const router = useRouter();
  const [period, setPeriod] = useState<PayPeriod>(initialPeriod);
  const [, startRefresh] = useTransition();

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
          onRefresh={handleRefresh}
        />
      </div>
    </>
  );
};
