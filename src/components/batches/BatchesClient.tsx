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

import { Badge } from '@/components/ui/Badge';
import { ConfirmDangerModal } from '@/components/ui/ConfirmDangerModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import type { PeriodSummaryRow } from '@/db/queries/payroll';
import {
  type ReconcileOverview,
  getReconcileOverview,
  reconcileAllPending,
} from '@/server/actions/reconcile';
import { useCallback, useEffect, useId, useState } from 'react';

interface BatchesClientProps {
  companyId: string;
  /** Locked + paid periods only (for the dropdown). */
  periods: PeriodSummaryRow[];
}

export const BatchesClient = ({ companyId, periods }: BatchesClientProps) => {
  const idBatch = useId();
  const { notify } = useToast();

  const [periodId, setPeriodId] = useState('');
  const [overview, setOverview] = useState<ReconcileOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

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

  return (
    <div>
      <div className="card">
        <h2>Reconcile with Wise</h2>
        <p className="sub">
          Pick a locked/paid period, then import the processed Wise CSV to backfill transfer IDs,
          poll status, and flag variances. Idempotent — safe to re-run.
        </p>

        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field">
            <label htmlFor={idBatch}>Batch (locked or paid)</label>
            <select id={idBatch} value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
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

        {/* Reconciliation overview */}
        <div className="card no-print" style={{ marginTop: 12 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <b>Reconciliation overview</b>
              <div className="sub" style={{ margin: '2px 0 0' }}>
                Every locked/paid period and its Wise reconcile status.
              </div>
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
              <table>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Contractors</th>
                    <th>Reconcile status</th>
                    <th />
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
                            onClick={() => setPeriodId(p.id)}
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
            transfer). For <b>unmatched</b> Wise rows, Open the period and run its per-period
            Reconcile to link the transfer first.
          </p>
        </div>
      </div>

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
