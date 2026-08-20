'use client';

import { useState } from 'react';
import type { PortalPaymentRow, PortalTimeEntryRow } from '@/db/queries/portal';
import { periodFor } from '@/lib/dates/periods';
import { peso } from '@/lib/format';
import { receiptModel } from '@/lib/pay/receipt';

interface Props {
  payments: PortalPaymentRow[];
  entries: PortalTimeEntryRow[];
}

/** Legacy "paid" = sent or reconciled (portal/index.html). */
const isPaid = (status: string): boolean => status === 'sent' || status === 'reconciled';

/** Time entries bucketed into one pay period: totals + per-day rows. */
type PeriodHours = {
  worked: number;
  pto: number;
  days: Array<{ date: string; tracked: number; pto: number }>;
};

/** Bucket own time entries by semi-monthly period start (hours, not seconds). Exported for tests. */
export const bucketHours = (entries: PortalTimeEntryRow[]): Map<string, PeriodHours> => {
  const map = new Map<string, PeriodHours>();
  for (const e of entries) {
    const key = periodFor(e.workDate).start;
    const b = map.get(key) ?? { worked: 0, pto: 0, days: [] };
    const tracked = e.trackedSeconds / 3600;
    const pto = e.ptoSeconds / 3600;
    b.worked += tracked;
    b.pto += pto;
    if (tracked > 0 || pto > 0) {
      const d = b.days.find((x) => x.date === e.workDate);
      if (d) {
        d.tracked += tracked;
        d.pto += pto;
      } else {
        b.days.push({ date: e.workDate, tracked, pto });
      }
    }
    map.set(key, b);
  }
  for (const b of map.values()) b.days.sort((a, z) => a.date.localeCompare(z.date));
  return map;
};

const h = (n: number): string => `${n.toFixed(2)} h`;

/**
 * Expanded pay-slip breakdown: the shared "How this pay was computed" receipt
 * (same model as the admin reports history) rendered with portal styling.
 * Extras are signed and always sum from gross to net; the basis line explains
 * how the gross was arrived at from the STORED statement inputs. Time entries
 * for the period feed the worked/PTO split and the per-day hours list.
 */
const SlipReceipt = ({ p, hours }: { p: PortalPaymentRow; hours: PeriodHours | undefined }) => {
  const { basis, gross, extras, paid } = receiptModel(
    { ...p.receipt, worked: hours ? hours.worked : null, pto: hours?.pto ?? 0 },
    peso,
  );
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
      {hours && hours.days.length > 0 && (
        <>
          {/* Owner: column labels only, no worked/PTO sum — the day rows speak for themselves. */}
          <div className="row" style={{ fontWeight: 600, ...divider }}>
            <span>Day</span>
            <span>Hours/PTO</span>
          </div>
          {hours.days.map((d) => (
            <div className="row" key={d.date}>
              <span className="k">{d.date}</span>
              <span>
                {h(d.tracked)}
                {d.pto > 0 ? ` + ${h(d.pto)} PTO` : ''}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
};

export const PortalStatements = ({ payments, entries }: Props) => {
  const [open, setOpen] = useState<string | null>(null);
  const hoursByPeriod = bucketHours(entries);

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
            {isOpen && <SlipReceipt p={p} hours={hoursByPeriod.get(p.periodStart)} />}
          </div>
        );
      })}
    </>
  );
};
