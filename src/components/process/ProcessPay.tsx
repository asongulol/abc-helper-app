'use client';

/**
 * ProcessPay — the per-period pay-execution panel (legacy ProcessPayroll detail,
 * index.html ~9098). Opened from the Process & Pay list via "Open & pay".
 *
 * Wires the existing-but-uncalled pay actions into one screen so a locked batch
 * is actually payable from the app:
 *   - Pay via Wise API   → wiseBatch (OWNER, drafts only — owner funds in Wise)
 *   - Download payment file (non-Wise rows) → buildBankExport (double-pay guard)
 *   - Check Wise status  → wiseStatus
 *   - Mark all paid / unpaid → markPaid / markAllUnpaid
 */

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { Badge, EmptyState } from '@/components/ui';
import { ConfirmDangerModal } from '@/components/ui/ConfirmDangerModal';
import { useToast } from '@/components/ui/Toast';
import type { ProcessPayment } from '@/db/queries/payroll';
import { peso } from '@/lib/format';
import { buildBankExport, downloadCsv } from '@/lib/payroll/bank-export';
import { getProcessPayments, markAllUnpaid, markPaid } from '@/server/actions/payroll';
import { wiseBatch, wiseStatus } from '@/server/actions/wise';

type Channel = 'wise' | 'bpi' | 'other';

interface Props {
  period: {
    id: string;
    periodStart: string;
    periodEnd: string;
    payDate: string | null;
    state: string;
    kind?: 'regular' | 'off_cycle';
  };
  companyId: string;
  initialPayments: ProcessPayment[];
  /** wiseBatch is OWNER-gated; hide the API control for non-owners. */
  isOwner: boolean;
}

const channelOf = (m: string | null): Channel =>
  m === 'wise' ? 'wise' : m === 'bpi' ? 'bpi' : 'other';
const sumPhp = (rows: ProcessPayment[]): number =>
  rows.reduce((s, p) => s + (p.netPhp != null ? Math.round(p.netPhp * 100) : 0), 0) / 100;

export function ProcessPay({ period, companyId, initialPayments, isOwner }: Props) {
  const { notify } = useToast();
  const [payments, setPayments] = useState(initialPayments);
  const [tab, setTab] = useState<Channel | 'all'>('all');
  const [busy, startBusy] = useTransition();
  const [confirm, setConfirm] = useState<null | 'paid' | 'unpaid'>(null);

  const refresh = async () => {
    const r = await getProcessPayments({ periodId: period.id, companyId });
    if (r.ok) setPayments(r.data.payments);
  };

  const inChannel = (c: Channel) => payments.filter((p) => channelOf(p.payoutMethod) === c);
  const wiseRows = inChannel('wise');
  const shown = tab === 'all' ? payments : inChannel(tab);
  const unpaidIds = payments.filter((p) => p.status !== 'sent').map((p) => p.paymentId);

  const title =
    period.kind === 'off_cycle'
      ? '⏱ Off-period batch'
      : `${period.periodStart} → ${period.periodEnd}`;

  // ── Pay via Wise API (OWNER): create draft transfers for Wise rows w/o one ──
  const payViaWise = () => {
    const ids = wiseRows.filter((p) => !p.wiseTransferId).map((p) => p.paymentId);
    if (ids.length === 0) {
      notify('No Wise contractors are waiting for a draft transfer.', { type: 'warn' });
      return;
    }
    startBusy(async () => {
      const r = await wiseBatch(ids);
      if (!r.ok) {
        notify(r.error, { type: 'error', persistent: true });
        return;
      }
      const drafted = r.data.results.filter((x) => x.transferId != null).length;
      const failed = r.data.results.filter((x) => x.error != null).length;
      notify(
        `Created ${drafted} Wise draft(s)${failed ? `, ${failed} failed` : ''}. Review and fund them in Wise — this app never funds.`,
        { type: failed ? 'error' : 'success', persistent: failed > 0 },
      );
      await refresh();
    });
  };

  // ── Check Wise status for drafted transfers ──
  const checkStatus = () => {
    const ids = wiseRows.filter((p) => p.wiseTransferId).map((p) => p.paymentId);
    if (ids.length === 0) {
      notify('No Wise transfers to check yet.', { type: 'warn' });
      return;
    }
    startBusy(async () => {
      const r = await wiseStatus(ids);
      if (!r.ok) {
        notify(r.error, { type: 'error' });
        return;
      }
      const seen = [...new Set(r.data.map((s) => s.wiseStatus).filter(Boolean))];
      notify(
        `Checked ${r.data.length} transfer(s).${seen.length ? ` Wise: ${seen.join(', ')}.` : ''}`,
        { type: 'info' },
      );
    });
  };

  // ── Download payment file for non-Wise rows (double-pay guard) ──
  const downloadFile = () => {
    const rows = payments
      .filter((p) => p.payoutMethod !== 'wise')
      .map((p) => ({ name: p.name, netPhp: p.netPhp ?? 0, payoutMethod: p.payoutMethod }));
    if (rows.length === 0) {
      notify('No non-Wise contractors to export — pay Wise rows via the API draft.', {
        type: 'warn',
      });
      return;
    }
    // ponytail: per-browser double-download guard via localStorage; upgrade to a
    // DB download-record if more than one admin ever pays the same batch.
    const key = `payfile:${period.id}`;
    const last = window.localStorage.getItem(key);
    if (
      last &&
      !window.confirm(
        `You already downloaded this payment file for this period on ${new Date(last).toLocaleString()}. Downloading again risks paying the batch twice. Download anyway?`,
      )
    ) {
      return;
    }
    const { csv, filename } = buildBankExport(rows, {
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
    });
    downloadCsv(csv, filename);
    window.localStorage.setItem(key, new Date().toISOString());
  };

  // ── Mark all paid / unpaid ──
  const doMarkPaid = () =>
    startBusy(async () => {
      const r = await markPaid({ companyId, paymentIds: unpaidIds });
      setConfirm(null);
      if (!r.ok) {
        notify(r.error, { type: 'error', persistent: true });
        return;
      }
      notify(`Marked ${r.data.markedCount} contractor(s) paid.`, { type: 'success' });
      await refresh();
    });

  const doMarkUnpaid = () =>
    startBusy(async () => {
      const r = await markAllUnpaid({ companyId, periodId: period.id });
      setConfirm(null);
      if (!r.ok) {
        notify(r.error, { type: 'error', persistent: true });
        return;
      }
      notify(`Marked ${r.data.markedCount} contractor(s) unpaid.`, { type: 'success' });
      await refresh();
    });

  const pill = (c: Channel | 'all', label: string) => {
    const rows = c === 'all' ? payments : inChannel(c);
    const active = tab === c;
    return (
      <button
        key={c}
        type="button"
        className={`btn sm ${active ? '' : 'ghost'}`}
        aria-pressed={active}
        onClick={() => setTab(c)}
      >
        {label} · {rows.length} · {peso(sumPhp(rows))}
      </button>
    );
  };

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Link className="btn ghost sm" href="/process">
          ← Back to batches
        </Link>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>Pay list — {title}</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          {period.payDate ? `Pay date ${period.payDate} — ` : ''}
          {payments.length} contractor(s) — total {peso(sumPhp(payments))}.{' '}
          <b>Mark each paid after you&apos;ve sent it.</b> Contractors are paid in PHP.
        </p>

        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {pill('wise', 'Wise')}
          {pill('bpi', 'BPI')}
          {pill('other', 'Other')}
          {pill('all', 'All')}
        </div>

        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {isOwner && (
            <button
              type="button"
              className="btn sm"
              disabled={busy || wiseRows.length === 0}
              onClick={payViaWise}
              title={wiseRows.length === 0 ? 'No Wise contractors in this batch.' : ''}
            >
              Pay via Wise API
            </button>
          )}
          <button type="button" className="btn ghost sm" disabled={busy} onClick={checkStatus}>
            Check Wise status
          </button>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={downloadFile}>
            Download payment file
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn sm"
            disabled={busy || unpaidIds.length === 0}
            onClick={() => setConfirm('paid')}
          >
            Mark all paid
          </button>
          <button
            type="button"
            className="btn ghost sm"
            disabled={busy}
            onClick={() => setConfirm('unpaid')}
          >
            Mark all unpaid
          </button>
        </div>

        {shown.length === 0 ? (
          <EmptyState message="No contractors in this view — switch the channel filter above." />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Contractor</th>
                  <th>Net ₱</th>
                  <th>Via</th>
                  <th>Status</th>
                  <th>Wise transfer</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.paymentId}>
                    <td className="card-title">{p.name}</td>
                    <td data-label="Net ₱">{peso(p.netPhp)}</td>
                    <td data-label="Via">{p.payoutMethod ?? '—'}</td>
                    <td data-label="Status">
                      {p.status === 'sent' ? (
                        <Badge tone="good">paid</Badge>
                      ) : (
                        <Badge tone="neutral">pending</Badge>
                      )}
                    </td>
                    <td data-label="Wise transfer">{p.wiseTransferId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirm === 'paid' && (
        <ConfirmDangerModal
          title="Mark all paid"
          message={`Mark ${unpaidIds.length} contractor(s) paid for ${title}? Do this only after you've actually sent the money.`}
          confirmLabel="Mark paid"
          busy={busy}
          onConfirm={doMarkPaid}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'unpaid' && (
        <ConfirmDangerModal
          title="Mark all unpaid"
          message={`Reverse paid status for this batch and return it to "ready to pay"? Rows already sent via Wise are left as-is and must be reversed individually.`}
          confirmLabel="Mark unpaid"
          busy={busy}
          onConfirm={doMarkUnpaid}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
