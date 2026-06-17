'use client';

import { useState } from 'react';
import type { PortalPaymentRow } from '@/db/queries/portal';
import { peso } from '@/lib/format';

interface Props {
  payments: PortalPaymentRow[];
}

/** Legacy "paid" = sent or reconciled (portal/index.html). */
const isPaid = (status: string): boolean => status === 'sent' || status === 'reconciled';

export const PortalStatements = ({ payments }: Props) => {
  const [open, setOpen] = useState<string | null>(null);

  if (!payments.length) {
    return <div className="empty">No pay slips yet.</div>;
  }

  // Summary stats — "paid" mirrors the legacy portal (sent or reconciled).
  const paidRows = payments.filter((p) => isPaid(p.status));
  const lastPaid = paidRows[0] ?? null;
  const received = paidRows.reduce((sum, p) => sum + p.netPhp, 0);
  // Remittance date of the FIRST (earliest) received pay slip — rows are sorted
  // newest-first, so the earliest paid one is last. Prefer the actual paid date.
  const firstPaid = paidRows[paidRows.length - 1] ?? null;
  const sinceDate = firstPaid
    ? firstPaid.paidAt
      ? firstPaid.paidAt.slice(0, 10)
      : firstPaid.payDate
    : null;

  return (
    <>
      <div className="pagehead">
        <span className="sticker">📮 Pay slips</span>
      </div>
      <div className="summary">
        <div className="scell">
          <div className="v">{lastPaid ? peso(lastPaid.netPhp) : '—'}</div>
          <div className="l">Last pay received</div>
        </div>
        <div className="scell">
          <div className="v">{peso(received)}</div>
          <div className="l">Total received{sinceDate ? ` · since ${sinceDate}` : ''}</div>
        </div>
      </div>
      {payments.map((p) => {
        const paid = isPaid(p.status);
        const isOpen = open === p.paymentId;
        return (
          // biome-ignore lint/a11y/useSemanticElements: card wraps block-level rows/sections that cannot be nested inside a native <button>; role=button + key handler give keyboard parity.
          <div
            className="card"
            key={p.paymentId}
            role="button"
            tabIndex={0}
            aria-expanded={isOpen}
            onClick={() => setOpen(isOpen ? null : p.paymentId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setOpen(isOpen ? null : p.paymentId);
              }
            }}
            style={{ cursor: 'pointer' }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
              }}
            >
              <div>
                <div style={{ fontWeight: 700 }}>
                  {p.periodStart} → {p.periodEnd}
                </div>
                <div className="sub">
                  Pay date {p.payDate || '—'} ·{' '}
                  <span className={`pill ${paid ? 'paid' : 'pending'}`}>
                    {paid ? 'paid' : 'pending'}
                  </span>{' '}
                  <span className="chev">{isOpen ? '▾' : '▸'}</span>
                </div>
              </div>
              <div className="net">{peso(p.netPhp)}</div>
            </div>
            {isOpen && (
              <div
                style={{
                  marginTop: 10,
                  borderTop: '1px solid var(--line)',
                  paddingTop: 8,
                }}
              >
                <div
                  className="row"
                  style={{
                    fontWeight: 600,
                    borderTop: '1px solid var(--line)',
                    marginTop: 4,
                    paddingTop: 6,
                  }}
                >
                  <span>Gross pay</span>
                  <span>{peso(p.grossPhp)}</span>
                </div>
                {p.haPhp > 0 && (
                  <div className="row">
                    <span className="k">Health allowance</span>
                    <span>{peso(p.haPhp)}</span>
                  </div>
                )}
                {p.t13Php > 0 && (
                  <div className="row">
                    <span className="k">13th month</span>
                    <span>{peso(p.t13Php)}</span>
                  </div>
                )}
                {p.pddPhp > 0 && (
                  <div className="row">
                    <span className="k">Lunch</span>
                    <span>{peso(p.pddPhp)}</span>
                  </div>
                )}
                {p.bonusPhp > 0 && (
                  <div className="row">
                    <span className="k">Bonus</span>
                    <span>{peso(p.bonusPhp)}</span>
                  </div>
                )}
                <div
                  className="row"
                  style={{
                    fontWeight: 700,
                    borderTop: '1px solid var(--line)',
                    marginTop: 4,
                    paddingTop: 6,
                  }}
                >
                  <span>Net pay</span>
                  <span>{peso(p.netPhp)}</span>
                </div>
                <div
                  className="row"
                  style={{
                    borderTop: '1px solid var(--line)',
                    marginTop: 4,
                    paddingTop: 6,
                  }}
                >
                  <span className="k">Paid via</span>
                  <span>{p.payoutMethod || '—'}</span>
                </div>
                {p.paidAt && (
                  <div className="row">
                    <span className="k">Date sent</span>
                    <span>{p.paidAt.slice(0, 10)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
};
