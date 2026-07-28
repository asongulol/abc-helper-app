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
import { Fragment, useMemo, useState, useTransition } from 'react';
import { Badge, EmptyState } from '@/components/ui';
import { ConfirmDangerModal } from '@/components/ui/ConfirmDangerModal';
import { useToast } from '@/components/ui/Toast';
import type { PayfileDownload } from '@/db/queries/audit';
import type { ProcessPayment } from '@/db/queries/payroll';
import { peso } from '@/lib/format';
import { downloadCsv } from '@/lib/payroll/bank-export';
import { buildIndividualPayments } from '@/lib/payroll/individual-payments';
import {
  isUnfundedWiseDraft,
  isUnpaidStatus,
  paymentStatusLabel,
  paymentStatusTone,
} from '@/lib/payroll/status-pills';
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
  /** Newest payment-file download per kind, from audit_log; null = read failed. */
  downloads: PayfileDownload[] | null;
  /** Records this download in audit_log so other admins see it (RP-59). */
  logDownload: (kind: 'wise' | 'individual', rows: number, totalPhp: number) => Promise<void>;
}

const channelOf = (m: string | null): Channel =>
  m === 'wise' ? 'wise' : m === 'bpi' ? 'bpi' : 'other';
const sumPhp = (rows: readonly { netPhp: number | null }[]): number =>
  rows.reduce((s, p) => s + (p.netPhp != null ? Math.round(p.netPhp * 100) : 0), 0) / 100;
/** Local calendar day (not UTC) — the default for "when did you send it". */
const todayLocal = (): string => new Date().toLocaleDateString('en-CA');

export function ProcessPay({
  period,
  companyId,
  initialPayments,
  isOwner,
  downloads,
  logDownload,
}: Props) {
  const { notify } = useToast();
  const [payments, setPayments] = useState(initialPayments);
  const [tab, setTab] = useState<Channel | 'all'>('all');
  const [busy, startBusy] = useTransition();
  const [confirm, setConfirm] = useState<null | 'paid' | 'unpaid'>(null);
  // Manual Wise batch file source currency (the funding balance). The TARGET is
  // always PHP — the file's amounts are pesos, so any other target overpays by
  // the FX rate; buildWiseBatch throws on one.
  const [srcCcy, setSrcCcy] = useState('USD');
  // Download records from audit_log (every admin, every machine). Prepended to
  // optimistically after each export so the stamp re-renders immediately.
  const [downloadLog, setDownloadLog] = useState(downloads);
  // Per-row mark-paid date entry: {paymentId, YYYY-MM-DD} while the row is open.
  const [dateFor, setDateFor] = useState<{ id: string; date: string } | null>(null);

  const refresh = async () => {
    const r = await getProcessPayments({ periodId: period.id, companyId });
    if (r.ok) {
      setPayments(r.data.payments);
      return;
    }
    // A silently failed refresh leaves the table showing pre-action state — say
    // so, otherwise a paid row still reads "unpaid" and gets paid again (RP-19).
    notify(`${r.error} The list below is out of date — reload the page.`, {
      type: 'error',
      persistent: true,
    });
  };

  const inChannel = (c: Channel) => payments.filter((p) => channelOf(p.payoutMethod) === c);
  const wiseRows = inChannel('wise');
  const wiseReady = wiseRows.filter((p) => !!p.wiseRecipientUuid).length;
  const wiseMissingUuid = wiseRows.filter((p) => !p.wiseRecipientUuid);
  // Build the batch file up front, not just on click: its `included` rows are
  // the only ones written, so its sum — NOT the sum of all Wise rows — is what
  // Wise shows after upload and what the owner funds against (RP-65).
  const wiseFile = useMemo(
    () =>
      buildWiseBatch(
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
        },
      ),
    [payments, period.periodStart, period.periodEnd, srcCcy],
  );
  const wiseFileTotal = sumPhp(wiseFile.included);
  const wiseDroppedTotal = sumPhp(wiseFile.dropped);
  const shown = tab === 'all' ? payments : inChannel(tab);
  // Default table order: contractor name A→Z.
  const shownSorted = [...shown].sort((a, b) => a.name.localeCompare(b.name));
  // Only draft/queued/failed rows are payable. `sent` and `reconciled` already
  // moved money — re-marking them overwrites their true send date (RP-08).
  const unpaid = payments.filter((p) => isUnpaidStatus(p.status));
  const unpaidIds = unpaid.map((p) => p.paymentId);
  // Of those, the ones whose Wise draft is still sitting unfunded (RP-58).
  const unfundedDrafts = unpaid.filter(isUnfundedWiseDraft).length;

  // Export stamp, two sources: the legacy per-browser localStorage key (survives
  // a failed audit write) and the audit_log record (survives a different admin,
  // machine or cleared profile — RP-59). Newest of the two wins.
  const stampKey = (kind: 'wise' | 'individual') => `payfile:${kind}:${period.id}`;
  const localStamp = (kind: 'wise' | 'individual'): string | null => {
    try {
      return window.localStorage.getItem(stampKey(kind));
    } catch {
      return null;
    }
  };
  const lastDownload = (kind: 'wise' | 'individual'): PayfileDownload | null => {
    const logged = downloadLog?.find((d) => d.kind === kind) ?? null;
    const local = localStamp(kind);
    if (local && (!logged || local > logged.at)) {
      return { kind, at: local, actor: null, byOther: false };
    }
    return logged;
  };
  /** "You downloaded" / "alice@x downloaded" — the guard must name who and when. */
  const who = (d: PayfileDownload) =>
    d.byOther ? (d.actor ?? 'Another admin') : d.actor ? 'You' : 'You (this browser)';

  const noteDownload = (kind: 'wise' | 'individual', rows: number, totalPhp: number) => {
    try {
      window.localStorage.setItem(stampKey(kind), new Date().toISOString());
    } catch {
      /* storage unavailable */
    }
    setDownloadLog((prev) => [
      { kind, at: new Date().toISOString(), actor: null, byOther: false },
      ...(prev ?? []).filter((d) => d.kind !== kind),
    ]);
    // Best-effort, like every other logEvent call — never block the download.
    void logDownload(kind, rows, totalPhp);
  };

  const downloadNote = (kind: 'wise' | 'individual') => {
    const d = lastDownload(kind);
    return (
      <>
        {d && (
          <span className="pill warn" style={{ marginLeft: 8 }}>
            {who(d)} downloaded this {new Date(d.at).toLocaleDateString()}
          </span>
        )}
        {/* Say when the guard is blind rather than implying "never downloaded". */}
        {downloadLog === null && (
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            Couldn&apos;t check whether another admin already downloaded this.
          </span>
        )}
      </>
    );
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
    const { csv, filename, included, dropped } = wiseFile;
    if (included.length === 0) {
      notify(
        dropped.length > 0
          ? `All ${dropped.length} Wise contractor(s) are missing a Wise recipient UUID — nothing to export. Add it on each contractor's profile.`
          : 'No Wise contractors in this batch to export.',
        { type: 'warn' },
      );
      return;
    }
    // Double-download guard. The record comes from audit_log, so it fires for a
    // second admin / another machine too — the multi-actor case this guard is
    // for (RP-59).
    // ponytail: the DB record is read once at page load; two admins downloading
    // within the same page view can still both pass. Re-read (or subscribe) here
    // if that ever actually happens.
    const last = lastDownload('wise');
    if (
      last &&
      !window.confirm(
        `${who(last)} already downloaded this Wise file for this period on ${new Date(last.at).toLocaleString()}. Downloading again risks paying the batch twice. Download anyway?`,
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
    noteDownload('wise', included.length, sumPhp(included));
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
    const last = lastDownload('individual');
    if (
      last &&
      !window.confirm(
        `${who(last)} already downloaded this payments file for this period on ${new Date(last.at).toLocaleString()}. Download again?`,
      )
    ) {
      return;
    }
    downloadCsv(csv, filename);
    noteDownload('individual', payments.length, sumPhp(payments));
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
  //    BPI / other pick the date the transfer actually happened, in an inline
  //    <input type="date"> (RP-64 — the old window.prompt made a fat-fingered
  //    month easy). Deliberately unbounded: payment may legally land on ANY day
  //    of the arrears window, so no min/max. ──
  const submitRowPaid = (p: ProcessPayment, day?: string) =>
    startBusy(async () => {
      const r = await markPaid({
        companyId,
        paymentIds: [p.paymentId],
        ...(day ? { paidAt: `${day}T00:00:00.000Z` } : {}),
      });
      setDateFor(null);
      if (!r.ok) {
        notify(r.error, { type: 'error', persistent: true });
        return;
      }
      notify(`Marked ${p.name} paid.`, { type: 'success' });
      await refresh();
    });

  const markRowPaid = (p: ProcessPayment) => {
    if (p.payoutMethod === 'wise') {
      submitRowPaid(p);
      return;
    }
    // Today, not period.payDate: we're asking when the transfer actually
    // happened, and pay_date is the deadline — always today or later (RP-05).
    setDateFor({ id: p.paymentId, date: todayLocal() });
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
            <table aria-label="Pay list">
              <thead>
                <tr>
                  <th scope="col">Contractor</th>
                  <th scope="col">Net ₱</th>
                  <th scope="col">Via</th>
                  <th scope="col">Status</th>
                  <th scope="col">Wise transfer</th>
                  <th scope="col" className="no-print" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shownSorted.map((p) => (
                  <tr key={p.paymentId}>
                    <td className="card-title">{p.name}</td>
                    <td data-label="Net ₱">{peso(p.netPhp)}</td>
                    <td data-label="Via">{p.payoutMethod ?? '—'}</td>
                    <td data-label="Status">
                      {/* All five enum states, not just sent/not-sent: a reconciled
                          row must not read "pending", nor a failed one (RP-57). */}
                      <Badge tone={paymentStatusTone(p.status)}>
                        {paymentStatusLabel(p.status)}
                      </Badge>
                    </td>
                    <td data-label="Wise transfer">{p.wiseTransferId ?? '—'}</td>
                    <td className="card-action no-print" style={{ textAlign: 'right' }}>
                      {!isUnpaidStatus(p.status) ? (
                        <span className="muted" style={{ fontSize: 12 }}>
                          ✓ {paymentStatusLabel(p.status)}
                        </span>
                      ) : dateFor?.id === p.paymentId ? (
                        <span
                          className="row"
                          style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'nowrap' }}
                        >
                          <input
                            type="date"
                            aria-label={`Date you sent ${p.name}'s payment`}
                            value={dateFor.date}
                            onChange={(e) => setDateFor({ id: p.paymentId, date: e.target.value })}
                          />
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy || !dateFor.date}
                            onClick={() => submitRowPaid(p, dateFor.date)}
                          >
                            Mark paid
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={busy}
                            onClick={() => setDateFor(null)}
                          >
                            Cancel
                          </button>
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
        {/* The file's own total, not the Wise-channel total above: rows without a
            recipient UUID are dropped, so the two differ exactly when some are
            missing. This is the figure Wise should show after upload (RP-65). */}
        <p className="sub" style={{ marginTop: -4 }}>
          File total <b>{peso(wiseFileTotal)}</b> across {wiseFile.included.length} recipient(s) —
          check this against Wise&apos;s preview before you fund.
          {wiseFile.dropped.length > 0 && (
            <>
              {' '}
              A further <b>{peso(wiseDroppedTotal)}</b> for {wiseFile.dropped.length} contractor(s)
              is <b>not</b> in the file (no Wise recipient UUID) and still has to be paid.
            </>
          )}
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
                    style={{ color: 'var(--bad)', textDecoration: 'underline' }}
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
          <span className="muted" style={{ fontSize: 11, paddingBottom: 6 }}>
            Paid out in <b>PHP</b> — the file&apos;s amounts are pesos.
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
        {downloadNote('wise')}
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
        {downloadNote('individual')}
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
          message={`Mark ${unpaidIds.length} contractor(s) paid for ${title}? Do this only after you've actually sent the money.${
            unfundedDrafts > 0
              ? ` ${unfundedDrafts} of them only have a Wise DRAFT transfer — no money moves until you fund the batch in Wise, so marking them paid now records a payment that hasn't happened.`
              : ''
          }`}
          confirmLabel="Mark paid"
          busy={busy}
          onConfirm={doMarkPaid}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'unpaid' && (
        <ConfirmDangerModal
          title="Mark all unpaid"
          message={`Reverse paid status for this batch and return it to "ready to pay"? Only rows marked paid outside Wise are reversed — rows with a Wise transfer are left as-is, and there is no per-row reversal in this app: cancel the transfer in Wise instead.`}
          confirmLabel="Mark unpaid"
          busy={busy}
          onConfirm={doMarkUnpaid}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
