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
 * Per-hour work is entered as hours in Time & Approval (any period), so the
 * sessions pane is per-session only.
 *
 * Catch-up pane (FT/PT contractors): leftover approved hours from an
 * already-locked/paid regular period, priced with the strict engine cap
 * (salariedCatchUpAmount) — auto-detected on the most recent finished run, or
 * entered manually for any past period.
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
import { salariedCatchUpAmount } from '@/lib/pay/catch-up';
import { centavosToPhp } from '@/lib/payroll/mappers';
import {
  addOffCyclePayItem,
  addSalariedCatchUp,
  getOffCycleEligibleWorkers,
  getOffCycleItems,
  getSalariedCatchUpCandidates,
  getUnpaidSessions,
  type OffCycleEligibleWorker,
  removeOffCyclePayItem,
} from '@/server/actions/payroll';
import type { CatchUpCandidate } from '@/server/payroll';

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
  const idCuWorker = useId();
  const idCuDate = useId();
  const idCuHours = useId();
  const idCuDesc = useId();
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

  // Catch-up pane (FT/PT leftover hours).
  const [pane, setPane] = useState<'sessions' | 'catchup'>('sessions');
  const [cu, setCu] = useState<{
    period: { id: string; periodStart: string; periodEnd: string } | null;
    candidates: CatchUpCandidate[];
    salariedWorkers: { workerId: string; name: string }[];
  } | null>(null);
  const [cuSelected, setCuSelected] = useState<Set<string>>(new Set());
  const [cuWorkerId, setCuWorkerId] = useState('');
  const [cuDate, setCuDate] = useState('');
  const [cuHours, setCuHours] = useState('');
  const [cuDesc, setCuDesc] = useState('');
  const [quote, setQuote] = useState<CatchUpCandidate | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [cuItems, setCuItems] = useState<OffCycleItemRow[]>([]);
  // Bumped after any catch-up add/remove so candidates, quote and items refetch.
  const [cuVersion, setCuVersion] = useState(0);

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
      setCuVersion((v) => v + 1);
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  // Catch-up candidates for the most recent locked/paid regular period.
  // biome-ignore lint/correctness/useExhaustiveDependencies(cuVersion): refetch counter — bumped after add/remove to force a reload
  useEffect(() => {
    if (pane !== 'catchup') return;
    let live = true;
    getSalariedCatchUpCandidates({ companyId }).then((res) => {
      if (!live) return;
      if (res.ok) setCu(res.data);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [companyId, pane, cuVersion]);

  // Manual-form quote: the selected worker's numbers on the chosen past period.
  // biome-ignore lint/correctness/useExhaustiveDependencies(cuVersion): refetch counter — bumped after add/remove to force a reload
  useEffect(() => {
    if (pane !== 'catchup' || !cuWorkerId || !cuDate) {
      setQuote(null);
      setQuoteError('');
      return;
    }
    let live = true;
    getSalariedCatchUpCandidates({ companyId, workerId: cuWorkerId, periodDate: cuDate }).then(
      (res) => {
        if (!live) return;
        if (res.ok) {
          setQuote(res.data.candidates[0] ?? null);
          setQuoteError(res.data.candidates.length === 0 ? 'No numbers for that period.' : '');
        } else {
          setQuote(null);
          setQuoteError(res.error);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [companyId, pane, cuWorkerId, cuDate, cuVersion]);

  // Existing catch-up items for the manual-selected worker (list + remove).
  // biome-ignore lint/correctness/useExhaustiveDependencies(cuVersion): refetch counter — bumped after add/remove to force a reload
  useEffect(() => {
    if (pane !== 'catchup' || !cuWorkerId || !periodId) {
      setCuItems([]);
      return;
    }
    let live = true;
    getOffCycleItems({ companyId, periodId, workerId: cuWorkerId }).then((res) => {
      if (!live) return;
      setCuItems(res.ok ? res.data.items.filter((i) => i.basis === 'salaried_hours') : []);
    });
    return () => {
      live = false;
    };
  }, [companyId, pane, cuWorkerId, periodId, cuVersion]);

  const cuLeftovers = cu?.candidates.filter((c) => c.leftoverHours > 0) ?? [];

  const toggleCatchUp = (workerId: string) =>
    setCuSelected((prev) => {
      const next = new Set(prev);
      if (next.has(workerId)) next.delete(workerId);
      else next.add(workerId);
      return next;
    });

  const handleAddDetected = async () => {
    if (!cu?.period || cuSelected.size === 0) return;
    setError('');
    setBusy(true);
    try {
      let added = 0;
      for (const c of cuLeftovers.filter((x) => cuSelected.has(x.workerId))) {
        const res = await addSalariedCatchUp({
          companyId,
          periodStart,
          periodEnd,
          workerId: c.workerId,
          originalPeriodDate: cu.period.periodStart,
          hours: c.leftoverHours,
        });
        if (!res.ok) {
          setError(`${c.name}: ${res.error}`);
          break;
        }
        added += 1;
      }
      if (added > 0) {
        notify(`Added ${added} catch-up ${added === 1 ? 'entry' : 'entries'}.`, {
          type: 'success',
        });
        setCuSelected(new Set());
        setCuVersion((v) => v + 1);
        onSaved();
      }
    } finally {
      setBusy(false);
    }
  };

  const manualHours = Number.parseFloat(cuHours) || 0;
  const manualAmount =
    quote && manualHours > 0
      ? salariedCatchUpAmount({
          rate: quote.rateCentavos,
          expectedHours: quote.expectedHours,
          paidHours: quote.paidHours,
          caughtUpHours: quote.caughtUpHours,
          leftoverHours: manualHours,
        })
      : null;
  const canAddManual = !busy && !!quote && manualHours > 0 && (manualAmount ?? 0) > 0;

  const handleAddManual = async () => {
    if (!cuWorkerId || !cuDate || manualHours <= 0) return;
    setError('');
    setBusy(true);
    try {
      const res = await addSalariedCatchUp({
        companyId,
        periodStart,
        periodEnd,
        workerId: cuWorkerId,
        originalPeriodDate: cuDate,
        hours: manualHours,
        ...(cuDesc.trim() ? { description: cuDesc.trim() } : {}),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      notify(`Catch-up added (${peso(res.data.amountPhp)}).`, { type: 'success' });
      setCuHours('');
      setCuDesc('');
      setCuVersion((v) => v + 1);
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const canPay = !!worker && selected.size > 0 && description.trim().length > 0 && !busy;
  const payMissing: string[] = [];
  if (pane === 'sessions' && worker && tab === 'pay' && !busy) {
    if (selected.size === 0) payMissing.push('select a session');
    if (description.trim().length === 0) payMissing.push('a description');
  }

  return (
    <Modal title="Off-cycle pay" onClose={onClose} maxWidth={680}>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button
          type="button"
          className={`btn sm ${pane === 'sessions' ? '' : 'ghost'}`}
          onClick={() => setPane('sessions')}
        >
          Sessions
        </button>
        <button
          type="button"
          className={`btn sm ${pane === 'catchup' ? '' : 'ghost'}`}
          onClick={() => setPane('catchup')}
        >
          Catch-up hours (FT/PT)
        </button>
      </div>

      {pane === 'sessions' && (
        <>
          <p className="sub" style={{ marginTop: 10, fontSize: 12 }}>
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
                        Approved sessions become payable under “Pay unpaid sessions” and in the
                        normal Calculate when their date falls in the period.
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
        </>
      )}

      {pane === 'catchup' && (
        <>
          <p className="sub" style={{ marginTop: 10, fontSize: 12 }}>
            Pay FT/PT hours that were approved after their period locked — priced exactly as the
            regular run would have (capped at 100% of the period rate). Pay lands on the open period{' '}
            <b>{fmtDate(periodStart)}</b> – <b>{fmtDate(periodEnd)}</b>.
          </p>

          {cu === null ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spinner />
            </div>
          ) : (
            <>
              <div style={sectionStyle}>
                <span className="section-label">
                  Leftover approved hours
                  {cu.period
                    ? ` — ${fmtDate(cu.period.periodStart)} – ${fmtDate(cu.period.periodEnd)}`
                    : ''}
                </span>
                {!cu.period ? (
                  <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
                    No locked or paid period to scan yet.
                  </p>
                ) : cuLeftovers.length === 0 ? (
                  <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
                    None — every FT/PT contractor's approved hours were paid in full. Use the manual
                    form below for an older period.
                  </p>
                ) : (
                  <>
                    <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 6 }}>
                      {cuLeftovers.map((c) => (
                        <label
                          key={c.workerId}
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
                            checked={cuSelected.has(c.workerId)}
                            onChange={() => toggleCatchUp(c.workerId)}
                          />
                          <span style={{ flex: 1 }}>{c.name}</span>
                          <span className="muted">
                            {c.leftoverHours}h left · {c.paidHours}h paid
                            {c.caughtUpHours > 0 ? ` · ${c.caughtUpHours}h caught up` : ''}
                          </span>
                          <b>
                            {c.amountCentavos === null
                              ? 'no rate'
                              : peso(centavosToPhp(c.amountCentavos))}
                          </b>
                        </label>
                      ))}
                    </div>
                    <div className="actions" style={{ marginTop: 8 }}>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy || cuSelected.size === 0}
                        onClick={handleAddDetected}
                      >
                        {busy ? 'Working…' : `Add selected (${cuSelected.size})`}
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div style={sectionStyle}>
                <span className="section-label">Manual — any locked/paid period</span>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    flexWrap: 'wrap',
                    marginTop: 6,
                    alignItems: 'flex-end',
                  }}
                >
                  <div className="field">
                    <label htmlFor={idCuWorker}>Contractor</label>
                    <select
                      id={idCuWorker}
                      value={cuWorkerId}
                      onChange={(e) => setCuWorkerId(e.target.value)}
                      style={{ padding: '4px 6px', fontSize: 13, minWidth: 180 }}
                    >
                      <option value="">— select —</option>
                      {cu.salariedWorkers.map((w) => (
                        <option key={w.workerId} value={w.workerId}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={idCuDate}>Date in that period</label>
                    <input
                      id={idCuDate}
                      type="date"
                      value={cuDate}
                      onChange={(e) => setCuDate(e.target.value)}
                      style={{ padding: '4px 6px', fontSize: 13 }}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={idCuHours}>Hours</label>
                    <input
                      id={idCuHours}
                      type="number"
                      min="0.25"
                      step="0.25"
                      value={cuHours}
                      onChange={(e) => setCuHours(e.target.value)}
                      style={{ width: 90, padding: '4px 6px', fontSize: 13 }}
                    />
                  </div>
                </div>
                <div className="field" style={{ marginTop: 8 }}>
                  <label htmlFor={idCuDesc}>Description (optional)</label>
                  <input
                    id={idCuDesc}
                    type="text"
                    value={cuDesc}
                    onChange={(e) => setCuDesc(e.target.value)}
                    placeholder="e.g. Late Hubstaff hours"
                    style={{ width: '100%', padding: '4px 6px', fontSize: 13 }}
                  />
                </div>
                {quoteError && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    {quoteError}
                  </p>
                )}
                {quote && (
                  <p style={{ fontSize: 13, marginTop: 6 }}>
                    {quote.paidHours}h paid of {quote.expectedHours}h expected
                    {quote.caughtUpHours > 0 ? `, ${quote.caughtUpHours}h caught up` : ''} →{' '}
                    <b>
                      {manualHours <= 0
                        ? 'enter hours'
                        : manualAmount === null
                          ? 'no rate for that period'
                          : peso(centavosToPhp(manualAmount))}
                    </b>
                  </p>
                )}
                <div className="actions" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!canAddManual}
                    onClick={handleAddManual}
                  >
                    {busy ? 'Working…' : 'Add catch-up'}
                  </button>
                </div>
              </div>

              {cuItems.length > 0 && (
                <div style={sectionStyle}>
                  <span className="section-label">Catch-up pay added this period</span>
                  {cuItems.map((it) => (
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
                        aria-label="Remove catch-up item"
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
        <p style={{ color: 'var(--bad)', fontSize: 13, marginTop: 10 }} role="alert">
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
          {pane === 'sessions' && worker && tab === 'pay' && (
            <button type="button" className="btn" disabled={!canPay} onClick={handlePay}>
              {busy ? 'Working…' : 'Add to pay'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
};
