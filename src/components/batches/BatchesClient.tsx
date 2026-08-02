'use client';

/**
 * Review & Recon Batches — client shell for /batches.
 * Ports the legacy ProcessPayroll(reconcileOnly=true) view (app/index.html
 * ~9615-9632) plus the embedded ReconcileOverview component (~8724-8817):
 *
 *   h2 "Reconcile with Wise" + sub
 *   "Batch (locked or paid)" dropdown (first option "Select…")
 *   "Reconciliation overview" card: bulk "Reconcile all pending (N)" + table
 *     (Period | Contractors | Reconcile status | Open).
 */

import { useCallback, useEffect, useId, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDangerModal } from '@/components/ui/ConfirmDangerModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import type { PeriodSummaryRow } from '@/db/queries/payroll';
import { matchSummary } from '@/lib/wise/match-summary';

import {
  getReconcileOverview,
  type ReconcileOverview,
  reconcileAllPending,
} from '@/server/actions/reconcile';
import {
  type PeriodMatchRow,
  wiseAttributeVariance,
  wiseLinkTransfer,
  wiseMatch,
  wisePeriodMatches,
  wisePoll,
  wiseUndoAttribution,
  wiseUnlinkTransfer,
} from '@/server/actions/wise';

interface BatchesClientProps {
  companyId: string;
  /** Locked + paid periods only (for the dropdown). */
  periods: PeriodSummaryRow[];
  /** Client companies a variance can be billed to. */
  clients: { id: string; name: string }[];
}

/** Where a reconcile variance can land. Mirrors AttributionTarget server-side. */
const TARGETS = [
  { value: 'misc', label: 'Miscellaneous' },
  { value: 'health_allowance', label: 'Health allowance' },
  { value: 'thirteenth_month', label: '13th month' },
] as const;

export const BatchesClient = ({ companyId, periods, clients }: BatchesClientProps) => {
  const idBatch = useId();
  const { notify } = useToast();

  const [periodId, setPeriodId] = useState('');
  const [overview, setOverview] = useState<ReconcileOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** The open period's payments, each with its transfer or the ones it could be. */
  const [rows, setRows] = useState<PeriodMatchRow[]>([]);
  const [rowsBusy, setRowsBusy] = useState(false);
  const [linking, setLinking] = useState('');
  /** The row whose link the operator is detaching (modal target). */
  const [unlinkFor, setUnlinkFor] = useState<PeriodMatchRow | null>(null);
  /** Raw "link this exact transfer" input, per payment: id + why. */
  const [byId, setById] = useState<Record<string, { transferId: string; reason: string }>>({});
  /** The row whose variance is being attributed, and to what. */
  const [attrFor, setAttrFor] = useState<string>('');
  const [attr, setAttr] = useState<{ target: string; label: string; companyId: string }>({
    target: 'misc',
    label: '',
    companyId: '',
  });

  /** Read-only: shows the period's matches and suggestions, writes nothing. */
  const openPeriod = useCallback(
    async (id: string) => {
      setPeriodId(id);
      setRows([]);
      if (!id) return;
      setRowsBusy(true);
      try {
        const res = await wisePeriodMatches(id);
        if (!res.ok) {
          notify(res.error, { type: 'error' });
          return;
        }
        setRows(res.data);
      } finally {
        setRowsBusy(false);
      }
    },
    [notify],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getReconcileOverview(companyId);
    if (!res.ok) {
      notify(res.error, { type: 'error' });
      setLoading(false);
      return;
    }
    setOverview(res.data);
    setLoading(false);
  }, [companyId, notify]);

  useEffect(() => {
    load();
  }, [load]);

  const totalReadySent = overview?.totalReadySent ?? 0;
  const pendingPeriods = overview?.pendingPeriods ?? 0;

  const reconcileAll = async () => {
    setConfirmOpen(false);
    setBusy(true);
    try {
      const res = await reconcileAllPending(companyId);
      if (!res.ok) {
        notify(`Reconcile-all failed: ${res.error}`, { type: 'error' });
        return;
      }
      notify(`Reconciled ${res.data.reconciled} payment(s) — now tagged Paid · Wise OK.`, {
        type: 'success',
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const ovPeriods = overview?.periods ?? [];
  const selected = ovPeriods.find((p) => p.id === periodId) ?? null;

  // Backfill missing wise_transfer_ids for the selected period (recipient +
  // amount + payment-date match; windows around paid_at when set).
  const runMatch = async () => {
    if (!periodId) return;
    setBusy(true);
    try {
      const res = await wiseMatch({ payPeriodId: periodId });
      if (!res.ok) {
        notify(`Match failed: ${res.error}`, { type: 'error' });
        return;
      }
      const { text, tone } = matchSummary(res.data);
      notify(text, { type: tone });
      await Promise.all([openPeriod(periodId), load()]);
    } finally {
      setBusy(false);
    }
  };

  /** Operator confirms one of the suggested transfers for one payment. */
  const linkTransfer = async (paymentId: string, transferId: string, reason?: string) => {
    setLinking(paymentId);
    try {
      const res = await wiseLinkTransfer(paymentId, transferId, reason);
      if (!res.ok) {
        notify(`Link failed: ${res.error}`, { type: 'error' });
        return;
      }
      const off = Math.abs(res.data.delta) >= 0.01;
      notify(
        `Linked transfer ${res.data.transferId}.` +
          (off
            ? ` Wise sent ₱${res.data.wiseAmount.toLocaleString()} against ₱${res.data.dbAmount.toLocaleString()} here — the payroll amount is unchanged.`
            : ''),
        { type: off ? 'warn' : 'success' },
      );
      await Promise.all([openPeriod(periodId), load()]);
    } finally {
      setLinking('');
    }
  };

  /**
   * Detach a link, with the reason that becomes its only record.
   *
   * The row loses its transfer id, dates, lock and paid_at, and a `reconciled`
   * row drops back to `sent` — so the modal says exactly that before it runs.
   */
  const unlinkTransfer = async (row: PeriodMatchRow, reason: string) => {
    setLinking(row.paymentId);
    try {
      const res = await wiseUnlinkTransfer(row.paymentId, reason);
      if (!res.ok) {
        notify(`Unlink failed: ${res.error}`, { type: 'error' });
        return;
      }
      setUnlinkFor(null);
      notify(`Unlinked transfer ${res.data.transferId}. Reason saved on the payment.`, {
        type: 'success',
      });
      await Promise.all([openPeriod(periodId), load()]);
    } finally {
      setLinking('');
    }
  };

  /**
   * Put the Wise-vs-payroll difference somewhere it can be read.
   *
   * The amount is deliberately NOT sent — the server reads it from the linked
   * transfer, so this can only ever close the gap the row is showing.
   */
  const attribute = async (paymentId: string) => {
    setLinking(paymentId);
    try {
      const res = await wiseAttributeVariance(
        paymentId,
        attr.target as 'misc' | 'health_allowance' | 'thirteenth_month',
        attr.label || undefined,
        attr.companyId || undefined,
      );
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      setAttrFor('');
      setAttr({ target: 'misc', label: '', companyId: '' });
      notify(
        `Attributed ₱${Math.abs(res.data.delta).toLocaleString()} — net is now ₱${res.data.netPhp.toLocaleString()}.`,
        { type: 'success' },
      );
      await Promise.all([openPeriod(periodId), load()]);
    } finally {
      setLinking('');
    }
  };

  const undoAttribution = async (paymentId: string) => {
    setLinking(paymentId);
    try {
      const res = await wiseUndoAttribution(paymentId);
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(`Attribution reversed — net is back to ₱${res.data.netPhp.toLocaleString()}.`, {
        type: 'success',
      });
      await Promise.all([openPeriod(periodId), load()]);
    } finally {
      setLinking('');
    }
  };

  const runPoll = async () => {
    setBusy(true);
    try {
      const res = await wisePoll();
      if (!res.ok) {
        notify(`Poll failed: ${res.error}`, { type: 'error' });
        return;
      }
      notify(`Polled ${res.data.checked} transfer(s) — ${res.data.updated} marked paid.`, {
        type: 'success',
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card" id="reconcile-batch-card">
        <h2>Reconcile with Wise</h2>
        <p className="sub">
          Pick a locked/paid batch, then <b>Match missing transfers</b> to backfill Wise transfer
          IDs (matched by recipient + amount + payment date) and <b>Poll status</b> to pull Wise
          state and flag variances. Idempotent — safe to re-run.
        </p>

        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field">
            <label htmlFor={idBatch}>Batch (locked or paid)</label>
            <select id={idBatch} value={periodId} onChange={(e) => openPeriod(e.target.value)}>
              <option value="">Select…</option>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.periodStart} → {p.periodEnd} ({p.state})
                </option>
              ))}
            </select>
          </div>
        </div>
        {periods.length === 0 && (
          <p className="muted" style={{ fontSize: 12 }}>
            No locked or paid batches yet — lock a batch on the Calculate tab first.
          </p>
        )}

        {/* Per-period reconcile — works for PAID periods too (Process & Pay only
            lists locked ones, so this is the only reconcile path after payout). */}
        {selected && (
          <div className="modal-section">
            <div className="card-head">
              <div>
                <b>
                  {selected.start} → {selected.end}
                </b>{' '}
                <span className="muted">{selected.state}</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                  {selected.unmatchedWise > 0 && (
                    <Badge tone="bad">{selected.unmatchedWise} unmatched</Badge>
                  )}
                  {selected.readySent > 0 && (
                    <Badge tone="warn">{selected.readySent} to reconcile</Badge>
                  )}
                  {selected.reconciled > 0 && <Badge tone="good">{selected.reconciled} ok</Badge>}
                  {selected.drafts > 0 && <Badge>{selected.drafts} draft</Badge>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy || selected.unmatchedWise === 0}
                  onClick={runMatch}
                  title="Search Wise history for transfers matching each unmatched payment (recipient + amount, near the payment date) and backfill the transfer IDs"
                >
                  {busy ? 'Working…' : `Match missing transfers (${selected.unmatchedWise})`}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={runPoll}
                  title="Fetch current Wise status for all payments that already have a transfer ID"
                >
                  Poll status
                </button>
              </div>
            </div>

            {/* Match keys on recipient id, so a transfer sent to an account this
                contractor's profile doesn't hold is invisible to it. These are
                the leftovers, with any Wise transfer that fits on amount — and
                on the recipient's name where Wise gave us one. Suggestions
                only: nothing is written until the operator picks one. */}
            {rowsBusy && (
              <div style={{ textAlign: 'center', padding: 24 }}>
                <Spinner />
              </div>
            )}

            {!rowsBusy && rows.length > 0 && (
              <div className="table-scroll" style={{ marginTop: 12 }}>
                <table aria-label="Payments in this period and their Wise transfers">
                  <thead>
                    <tr>
                      <th scope="col">Contractor</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Wise transfer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((u) => (
                      <tr key={u.paymentId}>
                        <td className="card-title">
                          <b>{u.workerName || '—'}</b>
                          <div className="muted" style={{ fontSize: 11 }}>
                            {u.reason ?? u.status}
                          </div>
                        </td>
                        <td data-label="Amount">₱{u.netPhp.toLocaleString()}</td>
                        <td data-label="Wise transfer">
                          {/* A linked row with a reason is linked to a transfer
                              that never paid — warn, and offer the real one. */}
                          {u.transferId && (
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                flexWrap: 'wrap',
                                marginBottom: u.reason ? 6 : 0,
                              }}
                            >
                              <Badge
                                tone={u.reason ? 'warn' : 'good'}
                                title={
                                  u.reason
                                    ? 'This transfer never paid — the link is not evidence of payment'
                                    : 'Already linked to this Wise transfer'
                                }
                              >
                                {u.reason ? '⚠' : '✓'} #{u.transferId}
                              </Badge>
                              <button
                                type="button"
                                className="btn ghost sm"
                                disabled={linking !== ''}
                                onClick={() => setUnlinkFor(u)}
                                title="Detach this transfer from this payment. Status-only — no money moves."
                              >
                                Unlink
                              </button>
                            </div>
                          )}
                          {u.transferId && !u.reason ? null : u.candidates.length === 0 ? (
                            <span className="muted" style={{ fontSize: 12 }}>
                              {u.payoutMethod === 'wise'
                                ? 'No Wise transfer for this amount in the pulled history.'
                                : `Paid by ${u.payoutMethod ?? 'another method'} — nothing to match.`}
                            </span>
                          ) : (
                            <div style={{ display: 'grid', gap: 6 }}>
                              {u.candidates.map((c) => (
                                <div
                                  key={c.transfer_id}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    flexWrap: 'wrap',
                                    gap: 6,
                                  }}
                                >
                                  <span>
                                    ₱{c.target_value.toLocaleString()}
                                    {c.created ? ` · ${c.created.slice(0, 10)}` : ''} ·{' '}
                                    <span className="muted">#{c.transfer_id}</span>
                                  </span>
                                  {c.recipient_name && (
                                    <Badge tone={c.name_matches ? 'good' : 'neutral'}>
                                      {c.name_matches ? `✓ ${c.recipient_name}` : c.recipient_name}
                                    </Badge>
                                  )}
                                  {c.ambiguous && (
                                    <Badge
                                      tone="warn"
                                      title="This same transfer also fits other unlinked payments — check before linking"
                                    >
                                      fits {c.shared_with_n_payments}
                                    </Badge>
                                  )}
                                  <button
                                    type="button"
                                    className="btn ghost sm"
                                    disabled={linking !== '' || !!u.transferId}
                                    onClick={() => linkTransfer(u.paymentId, c.transfer_id)}
                                    title={
                                      u.transferId
                                        ? 'Unlink the current transfer first — one transfer pays one row.'
                                        : 'Record this transfer as the one that paid this row. No money moves and the payroll amount is not changed.'
                                    }
                                  >
                                    {linking === u.paymentId ? 'Linking…' : 'Link'}
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          {/* Link ANY transfer: the matcher only ever offers what
                              falls inside the period's window, and a payment sent
                              early (or from a batch nobody recorded) never will. */}
                          {!u.transferId && u.payoutMethod === 'wise' && (
                            <div
                              style={{
                                display: 'flex',
                                gap: 6,
                                flexWrap: 'wrap',
                                alignItems: 'center',
                                marginTop: 6,
                              }}
                            >
                              <input
                                aria-label={`Wise transfer id for ${u.workerName}`}
                                placeholder="transfer id"
                                inputMode="numeric"
                                style={{ width: 120 }}
                                value={byId[u.paymentId]?.transferId ?? ''}
                                onChange={(e) =>
                                  setById((m) => ({
                                    ...m,
                                    [u.paymentId]: {
                                      transferId: e.target.value.trim(),
                                      reason: m[u.paymentId]?.reason ?? '',
                                    },
                                  }))
                                }
                              />
                              <input
                                aria-label={`Why this transfer for ${u.workerName}`}
                                placeholder="why (needed if outside the window)"
                                style={{ minWidth: 180, flex: 1 }}
                                value={byId[u.paymentId]?.reason ?? ''}
                                onChange={(e) =>
                                  setById((m) => ({
                                    ...m,
                                    [u.paymentId]: {
                                      transferId: m[u.paymentId]?.transferId ?? '',
                                      reason: e.target.value,
                                    },
                                  }))
                                }
                              />
                              <button
                                type="button"
                                className="btn ghost sm"
                                disabled={
                                  linking !== '' ||
                                  !/^\d+$/.test(byId[u.paymentId]?.transferId ?? '')
                                }
                                onClick={() =>
                                  linkTransfer(
                                    u.paymentId,
                                    byId[u.paymentId]?.transferId ?? '',
                                    byId[u.paymentId]?.reason,
                                  )
                                }
                                title="Link a transfer by its Wise id, including one the matcher would never suggest."
                              >
                                Link by ID
                              </button>
                            </div>
                          )}
                          {/* The gap between the payroll net and what Wise sent.
                              The matcher used to close it by rewriting net_php;
                              now the operator says where it belongs. */}
                          {u.delta != null && (
                            <div style={{ marginTop: 6 }}>
                              <div
                                style={{
                                  display: 'flex',
                                  gap: 6,
                                  alignItems: 'center',
                                  flexWrap: 'wrap',
                                }}
                              >
                                <Badge tone="warn" title="Wise sent a different amount">
                                  {u.delta > 0 ? '+' : '−'}₱{Math.abs(u.delta).toLocaleString()}
                                </Badge>
                                <span className="muted" style={{ fontSize: 11 }}>
                                  Wise sent ₱{(u.netPhp + u.delta).toLocaleString()}
                                </span>
                                <button
                                  type="button"
                                  className="btn ghost sm"
                                  disabled={linking !== ''}
                                  onClick={() =>
                                    setAttrFor(attrFor === u.paymentId ? '' : u.paymentId)
                                  }
                                >
                                  {attrFor === u.paymentId ? 'Cancel' : 'Attribute'}
                                </button>
                              </div>

                              {attrFor === u.paymentId && (
                                <div
                                  className="banner"
                                  style={{ display: 'grid', gap: 6, marginTop: 6 }}
                                >
                                  <div>
                                    Add {u.delta > 0 ? '+' : '−'}₱
                                    {Math.abs(u.delta).toLocaleString()} to:
                                  </div>
                                  {TARGETS.map((t) => (
                                    <label
                                      key={t.value}
                                      style={{ display: 'flex', gap: 6, alignItems: 'center' }}
                                    >
                                      <input
                                        type="radio"
                                        name={`attr-${u.paymentId}`}
                                        checked={attr.target === t.value}
                                        onChange={() => setAttr((a) => ({ ...a, target: t.value }))}
                                      />
                                      {t.label}
                                    </label>
                                  ))}
                                  {attr.target === 'misc' && (
                                    <>
                                      <input
                                        aria-label="What this difference is"
                                        placeholder="label, e.g. 123 BT Bookkeeping"
                                        value={attr.label}
                                        onChange={(e) =>
                                          setAttr((a) => ({ ...a, label: e.target.value }))
                                        }
                                      />
                                      <select
                                        aria-label="Bill this to"
                                        value={attr.companyId}
                                        onChange={(e) =>
                                          setAttr((a) => ({ ...a, companyId: e.target.value }))
                                        }
                                      >
                                        <option value="">For: (no client)</option>
                                        {clients.map((c) => (
                                          <option key={c.id} value={c.id}>
                                            {c.name}
                                          </option>
                                        ))}
                                      </select>
                                    </>
                                  )}
                                  <div className="actions">
                                    <button
                                      type="button"
                                      className="btn"
                                      disabled={linking !== ''}
                                      onClick={() => attribute(u.paymentId)}
                                    >
                                      {linking === u.paymentId ? 'Applying…' : 'Apply'}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          {u.attributed && u.delta == null && (
                            <button
                              type="button"
                              className="btn ghost sm"
                              style={{ marginTop: 6 }}
                              disabled={linking !== ''}
                              onClick={() => undoAttribution(u.paymentId)}
                              title="Reverse the last attribution on this row."
                            >
                              Undo attribution
                            </button>
                          )}
                          {u.note && (
                            <div
                              className="muted"
                              style={{ fontSize: 11, whiteSpace: 'pre-wrap', marginTop: 6 }}
                            >
                              {u.note}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Reconciliation overview — a hairline-separated sub-section, not a
            nested card (nested card chrome is an anti-pattern). */}
        <div className="modal-section no-print">
          <div className="card-head">
            <div>
              <b>Reconciliation overview</b>
              <div className="sub">Every locked/paid period and its Wise reconcile status.</div>
            </div>
            <button
              type="button"
              className="btn"
              disabled={busy || loading || !totalReadySent}
              onClick={() => setConfirmOpen(true)}
            >
              {busy ? 'Reconciling…' : `Reconcile all pending (${totalReadySent})`}
            </button>
          </div>

          {loading ? (
            <div style={{ textAlign: 'center', padding: 32 }}>
              <Spinner />
            </div>
          ) : ovPeriods.length === 0 ? (
            <EmptyState>No locked or paid periods yet.</EmptyState>
          ) : (
            <div className="table-scroll" style={{ marginTop: 8 }}>
              <table aria-label="Reconciliation overview">
                <thead>
                  <tr>
                    <th scope="col">Period</th>
                    <th scope="col">Contractors</th>
                    <th scope="col">Reconcile status</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {ovPeriods.map((p) => {
                    const done = p.total > 0 && p.reconciled === p.total;
                    return (
                      <tr key={p.id}>
                        <td className="card-title">
                          <b>
                            {p.start} → {p.end}
                          </b>{' '}
                          <span className="muted">{p.state}</span>
                        </td>
                        <td data-label="Contractors">{p.total}</td>
                        <td
                          data-label="Reconcile status"
                          style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
                        >
                          {done ? (
                            <Badge tone="good" title="All payments reconciled against Wise">
                              ✓ Paid · Wise OK
                            </Badge>
                          ) : (
                            <>
                              {p.readySent > 0 && (
                                <Badge tone="warn" title="Confirmed payments ready to finalize">
                                  {p.readySent} to reconcile
                                </Badge>
                              )}
                              {p.unmatchedWise > 0 && (
                                <Badge
                                  tone="bad"
                                  title="Wise payment with no matched transfer — match it per-period first"
                                >
                                  {p.unmatchedWise} unmatched
                                </Badge>
                              )}
                              {p.reconciled > 0 && <Badge tone="good">{p.reconciled} ok</Badge>}
                              {p.drafts > 0 && (
                                <Badge title="Not yet paid — handle in Process & Pay">
                                  {p.drafts} draft
                                </Badge>
                              )}
                            </>
                          )}
                        </td>
                        <td className="card-action" style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => {
                              openPeriod(p.id);
                              // The per-period panel renders at the top of this
                              // card — bring it into view so the click is visible.
                              document
                                .getElementById('reconcile-batch-card')
                                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            }}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            “Reconcile all pending” finalizes confirmed payments (non-Wise, or Wise with a matched
            transfer). For <b>unmatched</b> Wise rows, Open the period and run{' '}
            <b>Match missing transfers</b> to link them first.
          </p>
        </div>
      </div>

      {unlinkFor && (
        <ConfirmDangerModal
          title={`Unlink transfer #${unlinkFor.transferId}?`}
          message={`${unlinkFor.workerName || 'This payment'} — ₱${unlinkFor.netPhp.toLocaleString()}.`}
          consequence={
            'Clears the transfer id, the Wise dates, the reconcile lock and paid_at, and a reconciled row drops back to sent. ' +
            'Status-only — no money moves, and nothing changes in Wise.'
          }
          reasonLabel="Why are you unlinking it?"
          reasonPlaceholder="e.g. cancelled draft — the 14:10 batch actually paid this"
          confirmLabel="Unlink"
          busy={linking !== ''}
          onConfirm={(reason) => unlinkTransfer(unlinkFor, reason)}
          onCancel={() => setUnlinkFor(null)}
        />
      )}

      {confirmOpen && (
        <ConfirmDangerModal
          title={`Reconcile ${totalReadySent} payment(s)?`}
          message={`Finalize ${totalReadySent} confirmed payment(s) across ${pendingPeriods} period(s) as reconciled and tag them "Paid · Wise OK".`}
          consequence="Status-only — no money moves, and it's reversible by re-polling. Wise payments with NO matched transfer are left as 'sent' (flagged) for you to match per-period first."
          confirmLabel="Reconcile all pending"
          busy={busy}
          onConfirm={reconcileAll}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
};
