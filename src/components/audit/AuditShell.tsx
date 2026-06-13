'use client';

import type { AuditLogRow } from '@/db/queries/audit';
import { useRouter } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import { AuditTable } from './AuditTable';

interface AuditShellProps {
  rows: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
  filter: string;
  companyId: string;
}

/**
 * Client shell for the audit log page. Owns the URL state for filter + page,
 * and delegates rendering to AuditTable.
 */
export const AuditShell = ({
  rows,
  total,
  page,
  pageSize,
  filter,
  companyId: _companyId,
}: AuditShellProps) => {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const navigate = useCallback(
    (newPage: number, newFilter: string) => {
      const params = new URLSearchParams();
      if (newPage > 1) params.set('page', String(newPage));
      if (newFilter.trim()) params.set('q', newFilter.trim());
      const qs = params.toString();
      startTransition(() => {
        router.push(qs ? `/audit?${qs}` : '/audit');
      });
    },
    [router],
  );

  const onFilterChange = useCallback((f: string) => navigate(1, f), [navigate]);

  const onPageChange = useCallback((p: number) => navigate(p, filter), [navigate, filter]);

  return (
    <AuditTable
      rows={rows}
      total={total}
      page={page}
      pageSize={pageSize}
      filter={filter}
      onFilterChange={onFilterChange}
      onPageChange={onPageChange}
    />
  );
};
