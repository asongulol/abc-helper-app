'use client';

import { Badge, EmptyState, type SortableColumn, SortableTable, useToast } from '@/components/ui';
import type { ReportContractorRow, ReportPeriodRow } from '@/db/queries/reports';
import { centavosToPhp, fmtDate, money } from '@/lib/format';
import { buildPaymentDetailCsv, buildPeriodSummaryCsv, downloadCsv } from '@/lib/reports/csv';
import { getReportDetail } from '@/server/actions/reports';
import { useState, useTransition } from 'react';

// Browser-side PHP money helper
const php = (centavos: number) => money(centavosToPhp(centavos));

interface Props {
  periods: ReportPeriodRow[];
  ytd: ReportContractorRow[];
  companyId: string;
  defaultFrom: string;
  defaultTo: string;
  currentYear: number;
}

const STATE_TONE: Record<string, 'good' | 'warn' | 'neutral'> = {
  open: 'warn',
  locked: 'neutral',
  paid: 'good',
};

export const ReportsClient = ({
  periods: initialPeriods,
  ytd,
  companyId,
  defaultFrom,
  defaultTo,
  currentYear,
}: Props) => {
  const { notify } = useToast();
  const [periods, _setPeriods] = useState(initialPeriods);
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(defaultTo);
  const [activeTab, setActiveTab] = useState<'periods' | 'ytd'>('periods');
  const [isPending, _startTransition] = useTransition();
  const [_isExporting, startExport] = useTransition();

  const periodColumns: ReadonlyArray<SortableColumn<ReportPeriodRow>> = [
    {
      key: 'periodStart',
      label: 'Period',
      sortable: true,
      cardTitle: true,
      render: (r) => `${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}`,
      accessor: (r) => r.periodStart,
    },
    {
      key: 'payDate',
      label: 'Pay Date',
      sortable: true,
      render: (r) => fmtDate(r.payDate),
      accessor: (r) => r.payDate,
    },
    {
      key: 'state',
      label: 'State',
      sortable: true,
      render: (r) => <Badge tone={STATE_TONE[r.state] ?? 'neutral'}>{r.state}</Badge>,
      accessor: (r) => r.state,
    },
    {
      key: 'contractorCount',
      label: 'Contractors',
      sortable: true,
      accessor: (r) => r.contractorCount,
    },
    {
      key: 'totalGrossCentavos',
      label: 'Gross',
      sortable: true,
      render: (r) => php(r.totalGrossCentavos),
      accessor: (r) => r.totalGrossCentavos,
    },
    {
      key: 'totalHaCentavos',
      label: 'Health Allow.',
      render: (r) => php(r.totalHaCentavos),
      accessor: (r) => r.totalHaCentavos,
    },
    {
      key: 'totalT13Centavos',
      label: '13th Mo.',
      render: (r) => php(r.totalT13Centavos),
      accessor: (r) => r.totalT13Centavos,
    },
    {
      key: 'totalNetCentavos',
      label: 'Net',
      sortable: true,
      render: (r) => <strong>{php(r.totalNetCentavos)}</strong>,
      accessor: (r) => r.totalNetCentavos,
    },
  ];

  const ytdColumns: ReadonlyArray<SortableColumn<ReportContractorRow>> = [
    {
      key: 'workerName',
      label: 'Contractor',
      sortable: true,
      cardTitle: true,
    },
    {
      key: 'periodCount',
      label: 'Periods',
      sortable: true,
      accessor: (r) => r.periodCount,
    },
    {
      key: 'ytdGrossCentavos',
      label: 'YTD Gross',
      sortable: true,
      render: (r) => php(r.ytdGrossCentavos),
      accessor: (r) => r.ytdGrossCentavos,
    },
    {
      key: 'ytdHaCentavos',
      label: 'YTD HA',
      render: (r) => php(r.ytdHaCentavos),
      accessor: (r) => r.ytdHaCentavos,
    },
    {
      key: 'ytdT13Centavos',
      label: 'YTD 13th',
      render: (r) => php(r.ytdT13Centavos),
      accessor: (r) => r.ytdT13Centavos,
    },
    {
      key: 'ytdNetCentavos',
      label: 'YTD Net',
      sortable: true,
      render: (r) => <strong>{php(r.ytdNetCentavos)}</strong>,
      accessor: (r) => r.ytdNetCentavos,
    },
  ];

  // Grand totals
  const grandGross = periods.reduce((s, p) => s + p.totalGrossCentavos, 0);
  const grandNet = periods.reduce((s, p) => s + p.totalNetCentavos, 0);

  const handleExportPeriods = () => {
    const csv = buildPeriodSummaryCsv(periods);
    downloadCsv(`payroll-periods-${fromDate}-to-${toDate}.csv`, csv);
  };

  const _handleExportDetail = () => {
    startExport(async () => {
      const res = await getReportDetail({ companyId, fromDate, toDate });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      const csv = buildPaymentDetailCsv(res.data.rows);
      downloadCsv(`payroll-detail-${fromDate}-to-${toDate}.csv`, csv);
      notify('CSV exported.', { type: 'success' });
    });
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Reports</h2>
        <p className="sub">Payroll history by period and contractor.</p>
      </div>

      {/* Date range picker */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="sub">From</span>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              style={{ width: 148 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="sub">To</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              style={{ width: 148 }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              disabled={isPending}
              onClick={handleExportPeriods}
            >
              Export CSV
            </button>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 0 }}>
        {(['periods', 'ytd'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`btn ghost sm${activeTab === tab ? ' active' : ''}`}
            onClick={() => setActiveTab(tab)}
            style={{
              borderBottom: activeTab === tab ? '2px solid var(--accent)' : undefined,
              borderRadius: '4px 4px 0 0',
            }}
          >
            {tab === 'periods' ? 'Pay Periods' : `YTD ${currentYear}`}
          </button>
        ))}
      </div>

      <div className="card" style={{ borderTopLeftRadius: 0 }}>
        {activeTab === 'periods' ? (
          <>
            {periods.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  gap: 24,
                  marginBottom: 12,
                  padding: '10px 0',
                  borderBottom: '1px solid var(--border)',
                  flexWrap: 'wrap',
                }}
              >
                <span className="sub">
                  Grand Gross: <strong>{php(grandGross)}</strong>
                </span>
                <span className="sub">
                  Grand Net: <strong>{php(grandNet)}</strong>
                </span>
                <span className="sub">
                  {periods.length} period{periods.length !== 1 ? 's' : ''}
                </span>
              </div>
            )}
            <SortableTable
              columns={periodColumns}
              rows={periods}
              rowKey={(r) => r.periodId}
              filterPlaceholder="Filter periods…"
              emptyMessage={
                <EmptyState icon="📊" message="No payroll periods in the selected date range." />
              }
            />
          </>
        ) : (
          <SortableTable
            columns={ytdColumns}
            rows={ytd}
            rowKey={(r) => r.workerId}
            filterPlaceholder="Filter contractors…"
            emptyMessage={<EmptyState icon="📊" message={`No payroll data for ${currentYear}.`} />}
          />
        )}
      </div>
    </>
  );
};
