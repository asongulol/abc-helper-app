'use client';

import { useState } from 'react';
import type { PortalPaymentRow } from '@/db/queries/portal';
import { peso } from '@/lib/format';
import { receiptModel } from '@/lib/pay/receipt';

interface Props {
  payments: PortalPaymentRow[];
}

/** Legacy "paid" = sent or reconciled (portal/index.html). */
const isPaid = (status: string): boolean => status === 'sent' || status === 'reconciled';

/**
 * Expanded pay-slip breakdown: the shared "How this pay was computed" receipt
 * (same model as the admin reports history) rendered with portal styling.
 * Extras are signed and always sum from gross to net; the basis line explains
 * how the gross was arrived at from the STORED statement inputs.
 */
const SlipReceipt = ({ p }: { p: PortalPaymentRow }) => {
  const { basis, gross, extras, paid } = receiptModel(p.receipt, peso);
  const divider = {
    borderTop: '1px solid var(--line)',
    marginTop: 4,
    paddingTop: 6,
  } as const;
  return (
    <div
      style={{
        marginTop: 10,
        borderTop: '1px solid var(--line)',
        paddingTop: 8,
      }}
    >
      <div className="row" style={{ fontWeight: 600, ...divider }}>
        <span>Gross pay</span>
        <span>{peso(gross)}</span>
      </div>
      {basis && (
        <div className="sub" style={{ marginBottom: 4 }}>
          How it was computed: {basis}
        </div>
      )}
      {extras.map(([label, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: derived static list, never reordered
        <div className="row" key={`${label}-${i}`}>
          <span className="k">{label}</span>
          <span>{v < 0 ? `− ${peso(-v)}` : `+ ${peso(v)}`}</span>
        </div>
      ))}
      <div className="row" style={{ fontWeight: 700, ...divider }}>
        <span>Net pay</span>
        <span>{peso(p.netPhp)}</span>
      </div>
      {isPaid(p.status) && paid ? (
        <div className="sub" style={divider}>
          {paid}
        </div>
      ) : (
        <div className="row" style={divider}>
          <span className="k">Paid via</span>
          <span>{p.payoutMethod || '—'}</span>
        </div>
      )}
      {p.paidAt && (
        <div className="row">
          <span className="k">Date sent</span>
          <span>{p.paidAt.slice(0, 10)}</span>
        </div>
      )}
    </div>
  );
};

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
            {isOpen && <SlipReceipt p={p} />}
          </div>
        );
      })}
    </>
  );
};
