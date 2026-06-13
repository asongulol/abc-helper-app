'use client';

import {
  Badge,
  type BadgeTone,
  EmptyState,
  Modal,
  type SortableColumn,
  SortableTable,
} from '@/components/ui';
import type { PortalPaymentRow } from '@/db/queries/portal';
import { fmtDate, money } from '@/lib/format';
import { useState } from 'react';

interface Props {
  payments: PortalPaymentRow[];
}

const STATUS_TONE: Record<string, BadgeTone> = {
  draft: 'neutral',
  queued: 'warn',
  sent: 'good',
  failed: 'bad',
  reconciled: 'good',
};

export const PortalStatements = ({ payments }: Props) => {
  const [selected, setSelected] = useState<PortalPaymentRow | null>(null);

  const columns: ReadonlyArray<SortableColumn<PortalPaymentRow>> = [
    {
      key: 'periodStart',
      label: 'Period',
      sortable: true,
      cardTitle: true,
      render: (p) => `${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}`,
      accessor: (p) => p.periodStart,
    },
    {
      key: 'payDate',
      label: 'Pay Date',
      sortable: true,
      render: (p) => fmtDate(p.payDate),
      accessor: (p) => p.payDate,
    },
    {
      key: 'netPhp',
      label: 'Net Pay',
      sortable: true,
      render: (p) => <strong>{money(p.netPhp)}</strong>,
      accessor: (p) => p.netPhp,
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (p) => <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{p.status}</Badge>,
      accessor: (p) => p.status,
    },
    {
      key: 'payoutMethod',
      label: 'Via',
      render: (p) => p.payoutMethod ?? '—',
    },
  ];

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Pay Statements</h2>
        <p className="sub">Your payment history. Click any row for a full breakdown.</p>
      </div>

      <div className="card">
        <SortableTable
          columns={columns}
          rows={payments}
          rowKey={(p) => p.paymentId}
          filterPlaceholder="Filter by period, status…"
          emptyMessage={
            <EmptyState
              icon="💰"
              message="No pay statements yet. Check back after your first pay period."
            />
          }
          onRowClick={(p) => setSelected(p)}
        />
      </div>

      {selected !== null && (
        <Modal
          title={`Pay Statement — ${fmtDate(selected.periodStart)} to ${fmtDate(selected.periodEnd)}`}
          onClose={() => setSelected(null)}
          maxWidth={460}
        >
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '4px 16px',
              marginBottom: 12,
            }}
          >
            {[
              ['Pay Date', fmtDate(selected.payDate)],
              ['Status', selected.status],
              ['Via', selected.payoutMethod ?? '—'],
              ['Paid At', fmtDate(selected.paidAt)],
              ['Gross', money(selected.grossPhp)],
              ['Health Allow.', money(selected.haPhp)],
              ['13th Month', money(selected.t13Php)],
              ['PDD / Lunch', money(selected.pddPhp)],
              ['Bonus', money(selected.bonusPhp)],
              ['Deduction', money(selected.dedPhp)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="sub" style={{ fontSize: 11 }}>
                  {label}
                </dt>
                <dd style={{ margin: 0, fontWeight: 500 }}>{value}</dd>
              </div>
            ))}
          </dl>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 0',
              borderTop: '2px solid var(--border)',
              marginTop: 8,
            }}
          >
            <span style={{ fontWeight: 600 }}>Net Pay</span>
            <span style={{ fontWeight: 700, fontSize: 18 }}>{money(selected.netPhp)}</span>
          </div>
          <button
            type="button"
            className="btn ghost sm"
            style={{ marginTop: 12 }}
            onClick={() => setSelected(null)}
          >
            Close
          </button>
        </Modal>
      )}
    </>
  );
};
