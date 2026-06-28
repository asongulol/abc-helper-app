'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import { useToast } from '@/components/ui/Toast';
import type { AuditLogRow } from '@/db/queries/audit';
import { downloadCsv } from '@/lib/reports/csv';
import { exportAuditCsv } from '@/server/actions/audit';
import { AuditTable } from './AuditTable';

interface AuditShellProps {
  rows: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
  filter: string;
  dateFrom: string;
  dateTo: string;
  companyId: string;
}

/**
 * Client shell for the audit log page. Owns the URL state for filter + date
 * range + page, drives CSV export, and delegates rendering to AuditTable.
 */
export const AuditShell = ({
  rows,
  total,
  page,
  pageSize,
  filter,
  dateFrom,
  dateTo,
  companyId: _companyId,
}: AuditShellProps) => {
  const router = useRouter();
  const { notify } = useToast();
  const [, startTransition] = useTransition();
  const [exporting, setExporting] = useState(false);

  const navigate = useCallback(
    (next: { page?: number; filter?: string; from?: string; to?: string }) => {
      const params = new URLSearchParams();
      const p = next.page ?? 1;
      const f = (next.filter ?? filter).trim();
      const from = next.from ?? dateFrom;
      const to = next.to ?? dateTo;
      if (p > 1) params.set('page', String(p));
      if (f) params.set('q', f);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const qs = params.toString();
      startTransition(() => router.push(qs ? `/audit?${qs}` : '/audit'));
    },
    [router, filter, dateFrom, dateTo],
  );

  const onFilterChange = useCallback((f: string) => navigate({ filter: f }), [navigate]);
  const onPageChange = useCallback((p: number) => navigate({ page: p }), [navigate]);
  const onDateChange = useCallback(
    (from: string, to: string) => navigate({ from, to }),
    [navigate],
  );

  const onExport = useCallback(() => {
    setExporting(true);
    void (async () => {
      const res = await exportAuditCsv({
        ...(filter.trim() ? { filter: filter.trim() } : {}),
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {}),
      });
      setExporting(false);
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      downloadCsv(res.data.filename, res.data.csv);
    })();
  }, [filter, dateFrom, dateTo, notify]);

  return (
    <AuditTable
      rows={rows}
      total={total}
      page={page}
      pageSize={pageSize}
      filter={filter}
      dateFrom={dateFrom}
      dateTo={dateTo}
      exporting={exporting}
      onFilterChange={onFilterChange}
      onPageChange={onPageChange}
      onDateChange={onDateChange}
      onExport={onExport}
    />
  );
};
