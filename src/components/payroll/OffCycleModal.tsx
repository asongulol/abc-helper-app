'use client';

/**
 * Sessions modal for the Calculate batch — per-session contractors.
 *
 *  - "Add session": create a real service_sessions record (client, child, EIID,
 *    type, date), same fields as the contractor portal. Admin entry defaults to
 *    Approved, so it's immediately payable.
 *  - "Pay unpaid sessions": pick approved, not-yet-paid sessions (their date may
 *    fall OUTSIDE this period) and pay them on the open period. The amount is
 *    Σ units × rate; a durable ledger re-applies it on recalc and the paid_at
 *    guard blocks double-pay.
 *
 * Per-hour work is entered as hours in Time & Approval (any period), so this
 * modal is per-session only.
 */

import { useEffect, useId, useState } from 'react';
import { AddSessionForm } from '@/components/sessions/AddSessionForm';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import type { OffCycleItemRow } from '@/db/queries/payroll';
import type { UnpaidSessionRow } from '@/db/queries/sessions';
import { clientAlias } from '@/lib/clients';
import { fmtDate, peso } from '@/lib/format';
import {
  addOffCyclePayItem,
  getOffCycleEligibleWorkers,
  getOffCycleItems,
  getUnpaidSessions,
  type OffCycleEligibleWorker,
  removeOffCyclePayItem,
} from '@/server/actions/payroll';

interface OffCycleModalProps {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  /** The period's id when it already exists (so existing items can be listed). */
  periodId: string | null;
  onClose: () => void;
  /** Called after a successful add/remove so the caller can reload the draft. */
  onSaved: () => void;
}

const sectionStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border)',
  paddingTop: 10,
  marginTop: 10,
};

export const OffCycleModal = ({
  companyId,
  periodStart,
  periodEnd,
  periodId,
  onClose,
  onSaved,
}: OffCycleModalProps) => {
  const idWorker = useId();
  const idDesc = useId();
  const { notify } = useToast();

  const [workers, setWorkers] = useState<OffCycleEligibleWorker[] | null>(null);
  const [workerId, setWorkerId] = useState('');
  const worker = workers?.find((w) => w.workerId === workerId) ?? null;

  const [tab, setTab] = useState<'add' | 'pay'>('add');
  const [sessions, setSessions] = useState<UnpaidSessionRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [items, setItems] = useState<OffCycleItemRow[]>([]);
  const [description, setDescription] = useState('');

  const [loadingWorker, setLoadingWorker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Eligible workers = per-session only (per-hour is entered as hours elsewhere).
  useEffect(() => {
    let live = true;
    getOffCycleEligibleWorkers({ companyId }).then((res) => {
      if (!live) return;
      if (res.ok) setWorkers(res.data.workers.filter((w) => w.basis === 'per_session'));
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [companyId]);

  const reloadWorker = async () => {
    if (!workerId) return;
    const [sRes, iRes] = await Promise.all([
      getUnpaidSessions({ companyId, workerId }),
      periodId ? getOffCycleItems({ companyId, periodId, workerId }) : Promise.resolve(null),
    ]);
    setSessions(sRes.ok ? sRes.data.sessions : []);
    setItems(iRes?.ok ? iRes.data.items : []);
  };

  // Load the selected worker's unpaid sessions + existing items.
  useEffect(() => {
    if (!workerId) return;
    let live = true;
    setLoadingWorker(true);
    setSelected(new Set());
    Promise.all([
      getUnpaidSessions({ companyId, workerId }),
      periodId ? getOffCycleItems({ companyId, periodId, workerId }) : Promise.resolve(null),
    ]).then(([sRes, iRes]) => {
      if (!live) return;
      setSessions(sRes.ok ? sRes.data.sessions : []);
      setItems(iRes?.ok ? iRes.data.items : []);
      setLoadingWorker(false);
    });
    return () => {
      live = false;
    };
  }, [companyId, workerId, periodId]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handlePay = async () => {
    if (!worker || selected.size === 0 || !description.trim()) return;
    setError('');
    setBusy(true);
    try {
      const res = await addOffCyclePayItem({
        companyId,
        periodStart,
        periodEnd,
        workerId,
        basis: 'per_session',
        mode: 'pick',
        sessionIds: [...selected],
        description: description.trim(),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      notify('Sessions added to pay.', { type: 'success' });
      setSelected(new Set());
      setDescription('');
      await reloadWorker();
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (itemId: string) => {
    setError('');
    setBusy(true);
    try {
      const res = await removeOffCyclePayItem({ companyId, itemId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      notify('Off-cycle pay removed.', { type: 'success' });
      await reloadWorker();
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const canPay = !!worker && selected.size > 0 && description.trim().length > 0 && !busy;
  const payMissing: string[] = [];
  if (worker && tab === 'pay' && !busy) {
    if (selected.size === 0) payMissing.push('select a session');
    if (description.trim().length === 0) payMissing.push('a description');
  }

  return (
    <Modal title="Sessions" onClose={onClose} maxWidth={680}>
      <p className="sub" style={{ marginTop: 2, fontSize: 12 }}>
        Add a session for a per-session contractor, or pay approved sessions dated outside this
        period. Pay lands on the open period <b>{fmtDate(periodStart)}</b> –{' '}
        <b>{fmtDate(periodEnd)}</b>; already-paid sessions are blocked.
      </p>

      {workers === null ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spinner />
        </div>
      ) : workers.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
          No per-session contractors on this company.
        </p>
      ) : (
        <>
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor={idWorker}>Contractor</label>
            <select
              id={idWorker}
              value={workerId}
              onChange={(e) => setWorkerId(e.target.value)}
              style={{ padding: '4px 6px', fontSize: 13, minWidth: 260 }}
            >
              <option value="">— select —</option>
              {workers.map((w) => (
                <option key={w.workerId} value={w.workerId}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>

          {worker && loadingWorker && (
            <div style={{ textAlign: 'center', padding: 16 }}>
              <Spinner />
            </div>
          )}

          {worker && !loadingWorker && (
            <>
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <button
                  type="button"
                  className={`btn sm ${tab === 'add' ? '' : 'ghost'}`}
                  onClick={() => setTab('add')}
                >
                  Add session
                </button>
                <button
                  type="button"
                  className={`btn sm ${tab === 'pay' ? '' : 'ghost'}`}
                  onClick={() => setTab('pay')}
                >
                  Pay unpaid sessions{sessions.length > 0 ? ` (${sessions.length})` : ''}
                </button>
              </div>

              {tab === 'add' ? (
                <div style={sectionStyle}>
                  <AddSessionForm
                    companyId={companyId}
                    workerId={workerId}
                    defaultDate={periodStart}
                    onCreated={() => {
                      reloadWorker();
                    }}
                  />
                  <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                    Approved sessions become payable under “Pay unpaid sessions” and in the normal
                    Calculate when their date falls in the period.
                  </p>
                </div>
              ) : (
                <>
                  <div style={sectionStyle}>
                    <span className="section-label">Approved, unpaid sessions</span>
                    {sessions.length === 0 ? (
                      <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
                        None to pay. Add and approve a session under “Add session”.
                      </p>
                    ) : (
                      <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 6 }}>
                        {sessions.map((s) => (
                          <label
                            key={s.id}
                            style={{
                              display: 'flex',
                              gap: 8,
                              alignItems: 'center',
                              padding: '4px 0',
                              fontSize: 13,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selected.has(s.id)}
                              onChange={() => toggle(s.id)}
                            />
                            <span style={{ minWidth: 86 }}>{fmtDate(s.sessionDate)}</span>
                            <span className="muted" style={{ flex: 1 }}>
                              {clientAlias(s.companyName)}
                              {s.eiid ? ` · ${s.eiid}` : ''}
                              {s.sessionType ? ` · ${s.sessionType}` : ''}
                            </span>
                            <span>
                              {s.units} unit{s.units === 1 ? '' : 's'}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="field" style={{ marginTop: 10 }}>
                    <label htmlFor={idDesc}>Description (required)</label>
                    <input
                      id={idDesc}
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="e.g. Makeup sessions — May"
                      style={{ width: '100%', padding: '4px 6px', fontSize: 13 }}
                    />
                  </div>
                </>
              )}

              {/* Existing off-cycle pay items for this worker/period. */}
              {items.length > 0 && (
                <div style={sectionStyle}>
                  <span className="section-label">Off-cycle pay added this period</span>
                  {items.map((it) => (
                    <div
                      key={it.id}
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        marginTop: 6,
                        fontSize: 13,
                      }}
                    >
                      <span style={{ minWidth: 86 }}>{fmtDate(it.workDate)}</span>
                      <span className="muted" style={{ flex: 1 }}>
                        {it.description || '—'}
                      </span>
                      <b>{peso(it.amountPhp)}</b>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busy}
                        aria-label="Remove off-cycle item"
                        onClick={() => handleRemove(it.id)}
                        style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {error && (
        <p style={{ color: '#b91c1c', fontSize: 13, marginTop: 10 }} role="alert">
          {error}
        </p>
      )}

      <div className="actions between" style={{ gap: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {payMissing.length > 0 ? `Needs: ${payMissing.join(', ')}.` : ''}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
          {worker && tab === 'pay' && (
            <button type="button" className="btn" disabled={!canPay} onClick={handlePay}>
              {busy ? 'Working…' : 'Add to pay'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
};
