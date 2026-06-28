'use client';

/**
 * ProcessPay — the per-period pay-execution panel (legacy ProcessPayroll detail,
 * index.html ~9098). Opened from the Process & Pay list via "Open & pay".
 *
 * Wires the existing-but-uncalled pay actions into one screen so a locked batch
 * is actually payable from the app:
 *   - Pay list: channel pills (Wise/BPI/All), name-A→Z order, Print filtered view
 *   - Pay via Wise API   → wiseBatch (OWNER, drafts only — owner funds in Wise)
 *   - Check Wise status  → wiseStatus
 *   - 1 · Manual Wise batch file → buildWiseBatch (Wise-only, double-pay guard)
 *   - 2 · Individual payment files → buildIndividualPayments (all methods)
 *   - Mark all paid / unpaid → markPaid / markAllUnpaid
 */

import Link from 'next/link';
import { Fragment, useState, useTransition } from 'react';
import { Badge, EmptyState } from '@/components/ui';
import { ConfirmDangerModal } from '@/components/ui/ConfirmDangerModal';
import { useToast } from '@/components/ui/Toast';
import type { ProcessPayment } from '@/db/queries/payroll';
import { peso } from '@/lib/format';
import { downloadCsv } from '@/lib/payroll/bank-export';
import { buildIndividualPayments } from '@/lib/payroll/individual-payments';
import { buildWiseBatch } from '@/lib/payroll/wise-batch';
import { getProcessPayments, markAllUnpaid, markPaid } from '@/server/actions/payroll';
import { wiseBatch, wiseStatus } from '@/server/actions/wise';
import { WisePayoutsPanel } from './WisePayoutsPanel';

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
  // Manual Wise batch file currencies (default USD source → PHP target).
  const [srcCcy, setSrcCcy] = useState('USD');
  const [tgtCcy, setTgtCcy] = useState('PHP');
  // Bumped after each export so the "already downloaded" stamp re-renders.
  const [, setDownloadTick] = useState(0);

  const refresh = async () => {
    const r = await getProcessPayments({ periodId: period.id, companyId });
    if (r.ok) setPayments(r.data.payments);
  };

  const inChannel = (c: Channel) => payments.filter((p) => channelOf(p.payoutMethod) === c);
  const wiseRows = inChannel('wise');
  const wiseReady = wiseRows.filter((p) => !!p.wiseRecipientUuid).length;
  const wiseMissingUuid = wiseRows.filter((p) => !p.wiseRecipientUuid);
  const shown = tab === 'all' ? payments : inChannel(tab);
  // Default table order: contractor name A→Z.
  const shownSorted = [...shown].sort((a, b) => a.name.localeCompare(b.name));
  const unpaidIds = payments.filter((p) => p.status !== 'sent').map((p) => p.paymentId);

  // Per-browser export stamp (legacy `lastExported`): warns before a re-download
  // and shows "already downloaded {date}". Keyed by kind so the two files track
  // independently.
  const stampKey = (kind: 'wise' | 'individual') => `payfile:${kind}:${period.id}`;
  const lastDownloaded = (kind: 'wise' | 'individual'): string | null => {
    try {
      return window.localStorage.getItem(stampKey(kind));
    } catch {
      return null;
    }
  };
  const stampDownloaded = (kind: 'wise' | 'individual') => {
    try {
      window.localStorage.setItem(stampKey(kind), new Date().toISOString());
    } catch {
      /* storage unavailable */
    }
    setDownloadTick((t) => t + 1);
  };

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
      const r = await wiseBatch(ids.map((id) => ({ paymentId: id })));
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

  // ── 1 · Manual Wise batch file (Wise recipients only; double-pay guard) ──
  const downloadFile = () => {
    const { csv, filename, included, dropped } = buildWiseBatch(
      payments.map((p) => ({
        name: p.name,
        email: p.workerEmail,
        netPhp: p.netPhp ?? 0,
        payoutMethod: p.payoutMethod,
        wiseRecipientUuid: p.wiseRecipientUuid,
      })),
      {
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        sourceCurrency: srcCcy,
        targetCurrency: tgtCcy,
      },
    );
    if (included.length === 0) {
      notify(
        dropped.length > 0
          ? `All ${dropped.length} Wise contractor(s) are missing a Wise recipient UUID — nothing to export. Add it on each contractor's profile.`
          : 'No Wise contractors in this batch to export.',
        { type: 'warn' },
      );
      return;
    }
    // ponytail: per-browser double-download guard via localStorage; upgrade to a
    // DB download-record if more than one admin ever pays the same batch.
    const last = lastDownloaded('wise');
    if (
      last &&
      !window.confirm(
        `You already downloaded this Wise file for this period on ${new Date(last).toLocaleString()}. Downloading again risks paying the batch twice. Download anyway?`,
      )
    ) {
      return;
    }
    // Surface Wise rows that will be dropped (no recipient UUID → Wise rejects them).
    if (
      dropped.length > 0 &&
      !window.confirm(
        `${dropped.length} Wise contractor(s) have no Wise recipient UUID and will be DROPPED from the file:\n\n${dropped
          .slice(0, 15)
          .map((d) => `• ${d.name}`)
          .join(
            '\n',
          )}${dropped.length > 15 ? `\n…and ${dropped.length - 15} more` : ''}\n\nExport the ${included.length} contractor(s) with a UUID anyway?`,
      )
    ) {
      return;
    }
    downloadCsv(csv, filename);
    stampDownloaded('wise');
  };

  // ── 2 · Individual payment files (per-contractor breakdown, every method) ──
  const downloadIndividual = () => {
    const { csv, filename } = buildIndividualPayments(
      payments.map((p) => ({
        name: p.name,
        payoutMethod: p.payoutMethod,
        wiseRecipientId: p.wiseRecipientId,
        email: p.workerEmail,
        netPhp: p.netPhp ?? 0,
      })),
      { payDate: period.payDate, periodStart: period.periodStart, periodEnd: period.periodEnd },
    );
    const last = lastDownloaded('individual');
    if (
      last &&
      !window.confirm(
        `You already downloaded this payments file for this period on ${new Date(last).toLocaleString()}. Download again?`,
      )
    ) {
      return;
    }
    downloadCsv(csv, filename);
    stampDownloaded('individual');
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

  // ── Per-row mark paid. Wise uses now (its sent date is approximate anyway);
  //    BPI / other prompt for the date the transfer actually happened. ──
  const markRowPaid = (p: ProcessPayment) => {
    let paidAt: string | undefined;
    if (p.payoutMethod !== 'wise') {
      const def = period.payDate ?? new Date().toISOString().slice(0, 10);
      const entered = window.prompt(
        `Date you sent ${p.name}'s ${(p.payoutMethod ?? 'manual').toUpperCase()} payment (YYYY-MM-DD):`,
        def,
      );
      if (entered == null) return; // cancelled
      const d = entered.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        notify('Enter the date as YYYY-MM-DD.', { type: 'warn' });
        return;
      }
      paidAt = `${d}T00:00:00.000Z`;
    }
    startBusy(async () => {
      const r = await markPaid({
        companyId,
        paymentIds: [p.paymentId],
        ...(paidAt ? { paidAt } : {}),
      });
      if (!r.ok) {
        notify(r.error, { type: 'error', persistent: true });
        return;
      }
      notify(`Marked ${p.name} paid.`, { type: 'success' });
      await refresh();
    });
  };

  const pill = (c: Channel | 'all', label: string) => {
    const rows = c === 'all' ? payments : inChannel(c);
    const active = tab === c;
    return (
      <button
        key={c}
        type="button"
        className={`btn sm ${active ? '' : 'ghost'}`}
        style={{ borderRadius: 999, fontWeight: active ? 600 : 500 }}
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

      <div className="card" id="paylist-print">
        <h2 style={{ marginBottom: 4 }}>Pay list — {title}</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          {period.payDate ? `Pay date ${period.payDate} — ` : ''}
          {tab === 'all'
            ? `${payments.length} contractor(s) — total ${peso(sumPhp(payments))}`
            : `${tab.toUpperCase()} · ${shown.length} contractor(s) — ${peso(sumPhp(shown))}`}
          . <b>Mark each paid after you&apos;ve sent it.</b> Contractors are paid in PHP.
        </p>

        <div className="row no-print" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => window.print()}
            title="Print the current filtered view"
          >
            Print
          </button>
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

        {/* Channel filter — pills sit below the action bar, above the table
            (matches the legacy Pay list). 'Other' shows only when populated. */}
        <div className="row no-print" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {pill('wise', 'Wise')}
          {pill('bpi', 'BPI')}
          {inChannel('other').length > 0 && pill('other', 'Other')}
          {pill('all', 'All')}
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
                  <th className="no-print" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shownSorted.map((p) => (
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
                    <td className="card-action no-print" style={{ textAlign: 'right' }}>
                      {p.status === 'sent' ? (
                        <span className="muted" style={{ fontSize: 12 }}>
                          ✓ paid
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={busy}
                          onClick={() => markRowPaid(p)}
                        >
                          {p.payoutMethod === 'wise' ? 'Mark paid' : 'Mark paid…'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 1 · Manual Wise batch file — currency selects + dropped-UUID surface. */}
      <div className="card no-print">
        <h3 style={{ margin: '0 0 4px' }}>1 · Manual Wise batch file</h3>
        <p className="sub">
          Downloads a CSV in Wise&apos;s exact batch-upload template, keyed by each recipient&apos;s
          Wise ID ({wiseReady} of {wiseRows.length} Wise contractor(s) ready). Upload it on your
          Wise account → Batch payments. You fund it in Wise.
        </p>
        {wiseMissingUuid.length > 0 && (
          <div className="banner error" style={{ marginBottom: 12 }}>
            <span>
              <b>{wiseMissingUuid.length} Wise contractor(s) have no stored Wise recipient UUID</b>{' '}
              and will be dropped from the CSV:{' '}
              {wiseMissingUuid.map((r, i) => (
                <Fragment key={r.paymentId}>
                  {i > 0 && ', '}
                  <Link
                    href={`/contractors/${r.workerId}`}
                    style={{ color: '#b91c1c', textDecoration: 'underline' }}
                  >
                    {r.name}
                  </Link>
                </Fragment>
              ))}
              . Open each profile and paste the UUID into the &ldquo;Wise recipient UUID&rdquo;
              field (from Wise → Batch payments → Download all templates).
            </span>
          </div>
        )}
        <div className="row" style={{ alignItems: 'flex-end', gap: 12, marginBottom: 8 }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor={`${period.id}-src`} style={{ fontSize: 12 }}>
              Source currency
            </label>
            <select
              id={`${period.id}-src`}
              value={srcCcy}
              onChange={(e) => setSrcCcy(e.target.value)}
            >
              <option value="USD">USD</option>
              <option value="PHP">PHP</option>
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor={`${period.id}-tgt`} style={{ fontSize: 12 }}>
              Target currency
            </label>
            <select
              id={`${period.id}-tgt`}
              value={tgtCcy}
              onChange={(e) => setTgtCcy(e.target.value)}
            >
              <option value="PHP">PHP</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <span className="muted" style={{ fontSize: 11, paddingBottom: 6 }}>
            Default USD → PHP.
          </span>
        </div>
        <button
          type="button"
          className="btn"
          disabled={busy || wiseReady === 0}
          onClick={downloadFile}
        >
          Download Wise batch CSV ({wiseReady})
        </button>
        {wiseRows.length === 0 && (
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            No Wise-method contractors in this period.
          </span>
        )}
        {lastDownloaded('wise') && (
          <span className="pill warn" style={{ marginLeft: 8 }}>
            already downloaded {new Date(lastDownloaded('wise') as string).toLocaleDateString()}
          </span>
        )}
      </div>

      {/* 2 · Individual payment files — all methods, incl. BPI (record-keeping). */}
      <div className="card no-print">
        <h3 style={{ margin: '0 0 4px' }}>2 · Individual payment files</h3>
        <p className="sub">
          A per-contractor breakdown of all {payments.length} payments (every method, incl. BPI),
          with amounts, methods and pay date — for manual/individual payments and record-keeping.
        </p>
        <button type="button" className="btn ghost" disabled={busy} onClick={downloadIndividual}>
          Download payments CSV ({payments.length})
        </button>
        {lastDownloaded('individual') && (
          <span className="pill warn" style={{ marginLeft: 8 }}>
            already downloaded{' '}
            {new Date(lastDownloaded('individual') as string).toLocaleDateString()}
          </span>
        )}
      </div>

      {/* 3 · Automatic Wise API draft — editable draft panel (drafts only). */}
      <div className="card no-print">
        <h3 style={{ margin: '0 0 4px' }}>3 · Automatic Wise API draft</h3>
        <p className="sub">
          Draft the Wise transfers directly via the API (drafts only — you fund in Wise). Edit
          recipients and amounts per person, then create one batch.
        </p>
        <WisePayoutsPanel
          periodEnd={period.periodEnd}
          payments={payments}
          isOwner={isOwner}
          onDrafted={refresh}
        />
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
