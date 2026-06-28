'use client';

import { useState } from 'react';
import type { SortableColumn } from '@/components/ui';
import { EmptyState, SortableTable } from '@/components/ui';
import type { AuditLogRow } from '@/db/queries/audit';
import type { Json } from '@/db/types';
import { fmtDateTime } from '@/lib/format';

interface AuditTableProps {
  rows: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
  filter: string;
  dateFrom: string;
  dateTo: string;
  exporting: boolean;
  onFilterChange: (f: string) => void;
  onPageChange: (p: number) => void;
  onDateChange: (from: string, to: string) => void;
  onExport: () => void;
}

/** Pretty-print a JSON detail value, or stringify if not an object. */
const prettyDetail = (detail: Json | null): string => {
  if (detail == null) return '—';
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
};

/**
 * Client-side audit log table with:
 * - text filter on action + entity (server-side via URL params)
 * - expandable detail JSON cell
 * - pagination controls
 */
export const AuditTable = ({
  rows,
  total,
  page,
  pageSize,
  filter,
  dateFrom,
  dateTo,
  exporting,
  onFilterChange,
  onPageChange,
  onDateChange,
  onExport,
}: AuditTableProps) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const columns: ReadonlyArray<SortableColumn<AuditLogRow>> = [
    {
      key: 'createdAt',
      label: 'When',
      sortable: true,
      cardTitle: true,
      accessor: (r) => r.createdAt,
      render: (r) => <span style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.createdAt)}</span>,
    },
    {
      key: 'actor',
      label: 'By',
      sortable: true,
      accessor: (r) => r.actor ?? '',
      render: (r) => <span className="muted">{r.actor ?? '—'}</span>,
    },
    {
      key: 'action',
      label: 'Action',
      sortable: true,
      accessor: (r) => r.action,
    },
    {
      key: 'entity',
      label: 'Item',
      sortable: true,
      accessor: (r) => r.entity ?? '',
      render: (r) => r.entity ?? <span className="muted">—</span>,
    },
    {
      key: 'detail',
      label: 'Detail',
      sortable: false,
      render: (r) => {
        if (r.detail == null) return <span className="muted">—</span>;
        const isExpanded = expandedId === r.id;
        return (
          <div>
            <button
              type="button"
              className="btn ghost sm"
              onClick={(e) => {
                e.stopPropagation();
                setExpandedId(isExpanded ? null : r.id);
              }}
              aria-expanded={isExpanded}
              aria-label={isExpanded ? 'Collapse detail' : 'Expand detail'}
            >
              {isExpanded ? '▲ Collapse' : '▼ Expand'}
            </button>
            {isExpanded && (
              <pre
                style={{
                  marginTop: 8,
                  fontSize: 11,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '8px 10px',
                  overflowX: 'auto',
                  maxWidth: 400,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {prettyDetail(r.detail)}
              </pre>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div>
      {/* Filter input — changes are pushed to the URL by the parent */}
      <div
        style={{
          marginBottom: 12,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <input
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Filter by action or entity…"
          aria-label="Filter audit log"
          style={{ maxWidth: 300 }}
        />
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>
          From{' '}
          <input
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => onDateChange(e.target.value, dateTo)}
            aria-label="Filter from date"
          />
        </label>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>
          To{' '}
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => onDateChange(dateFrom, e.target.value)}
            aria-label="Filter to date"
          />
        </label>
        {(dateFrom || dateTo) && (
          <button type="button" className="btn ghost sm" onClick={() => onDateChange('', '')}>
            Clear dates
          </button>
        )}
        <span className="muted" style={{ fontSize: 12 }}>
          {total} total entr{total === 1 ? 'y' : 'ies'}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn ghost sm"
          disabled={exporting || total === 0}
          onClick={onExport}
        >
          {exporting ? 'Exporting…' : '⬇ Export CSV'}
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon="📝"
          message={filter ? 'No audit entries match your filter.' : 'No audit entries yet.'}
        />
      ) : (
        <SortableTable columns={columns} rows={rows} rowKey={(r) => r.id} filterable={false} />
      )}

      {totalPages > 1 && (
        <div
          className="actionbar"
          style={{
            justifyContent: 'center',
            marginTop: 12,
            borderTop: 'none',
            paddingTop: 0,
          }}
        >
          <button
            type="button"
            className="btn ghost sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            aria-label="Previous page"
          >
            ← Prev
          </button>
          <span className="muted" style={{ fontSize: 12, padding: '0 8px' }}>
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            className="btn ghost sm"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            aria-label="Next page"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
};
