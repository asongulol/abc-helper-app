'use client';

/**
 * PayrollShell — client shell for the /payroll page.
 * Mirrors the legacy Calculate tab: batch list, period picker, draft table,
 * lock/unlock, delete, misc popup.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDangerModal } from '@/components/ui/ConfirmDangerModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import type { PeriodSummaryRow, SavedPayment } from '@/db/queries/payroll';
import type { PayPeriod } from '@/lib/dates/periods';
import { periodFor } from '@/lib/dates/periods';
import { centavosToPhp, fmtDate, money } from '@/lib/format';
import { centavos } from '@/lib/money';
import type { MiscItem } from '@/lib/pay/calc';
import { usdReference } from '@/lib/pay/calc';
import { recomputeNetCentavos } from '@/lib/payroll/row-net';
import { payoutMethodLabel, periodStateLabel, periodStateTone } from '@/lib/payroll/status-pills';
import {
  calculatePeriodDraft,
  deleteAllStatements,
  deleteStatement,
  getSavedPayments,
  lockPeriod,
  restorePaymentsSnapshot,
  unlockPeriod,
  updatePaymentRowAction,
} from '@/server/actions/payroll';
import type { MiscModalPayload } from './MiscModal';

// Misc-items editor (496 lines) loads on first open, gated behind miscRowId.
const MiscModal = dynamic(() => import('./MiscModal').then((m) => m.MiscModal), { ssr: false });
// Off-cycle per-session/per-hour pay editor, gated behind showOffCycle.
const OffCycleModal = dynamic(() => import('./OffCycleModal').then((m) => m.OffCycleModal), {
  ssr: false,
});

const PAYOUT_METHODS = ['wise', 'bpi', 'gcash', 'paymaya', 'paypal'] as const;
const DEFAULT_FX = 58.0;

type EditableRow = {
  paymentId: string;
  workerId: string;
  name: string;
  workedHours: number;
  expectedHours: number;
  ratio: number;
  ratePhp: number | null;
  grossPhp: number | null;
  computedGrossPhp: number | null;
  overridden: boolean;
  haPhp: number;
  t13Php: number;
  computedT13Php: number;
  pddPhp: number;
  bonusPhp: number;
  miscItems: MiscItem[];
  offCyclePhp: number;
  netPhp: number | null;
  payoutMethod: string | null;
  inactive: boolean;
};

interface PayrollShellProps {
  companyId: string;
  isOwner: boolean;
  defaultPeriod: PayPeriod;
  initialPeriods: PeriodSummaryRow[];
  /** Deep-link from Process & Pay → open the unlock modal once the locked period loads. */
  autoUnlock?: boolean;
}

// Convert SavedPayment to EditableRow
const toEditableRow = (p: SavedPayment): EditableRow => ({
  paymentId: p.paymentId,
  workerId: p.workerId,
  name: p.name,
  workedHours: p.workedHours,
  expectedHours: p.expectedHours,
  ratio: p.ratio,
  ratePhp: p.ratePhp,
  grossPhp: p.grossPhp,
  computedGrossPhp: p.grossPhp,
  overridden: p.overridden,
  haPhp: p.haPhp,
  t13Php: p.t13Php,
  computedT13Php: p.t13Php,
  pddPhp: p.pddPhp,
  bonusPhp: p.bonusPhp,
  miscItems: p.miscItems,
  offCyclePhp: p.offCyclePhp,
  netPhp: p.netPhp,
  payoutMethod: p.payoutMethod,
  inactive: false,
});

const recomputeRow = (r: EditableRow): EditableRow => {
  const netC = recomputeNetCentavos({
    grossPhp: r.grossPhp,
    haPhp: r.haPhp,
    t13Php: r.t13Php,
    pddPhp: r.pddPhp,
    bonusPhp: r.bonusPhp,
    miscItems: r.miscItems,
    offCyclePhp: r.offCyclePhp,
  });
  return { ...r, netPhp: netC != null ? centavosToPhp(netC) : null };
};

export const PayrollShell = ({
  companyId,
  isOwner: _isOwner,
  defaultPeriod,
  initialPeriods,
  autoUnlock = false,
}: PayrollShellProps) => {
  const idPeriodStart = useId();
  const idFxRef = useId();
  const { notify } = useToast();
  const [periods, setPeriods] = useState<PeriodSummaryRow[]>(initialPeriods);
  const [showFinished, setShowFinished] = useState(false);

  // Current period state
  const [periodStart, setPeriodStart] = useState(defaultPeriod.start);
  const [periodEnd, setPeriodEnd] = useState(defaultPeriod.end);
  const [payDate, setPayDate] = useState(defaultPeriod.payDate);
  const [currentPeriod, setCurrentPeriod] = useState<PeriodSummaryRow | null>(null);

  // FX
  const [fx, setFx] = useState(DEFAULT_FX);
  const [fxNote, setFxNote] = useState('');

  // Toggles
  const [includeHA, setIncludeHA] = useState(true);
  const [include13, setInclude13] = useState(false);

  // Draft rows
  const [rows, setRows] = useState<EditableRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const suppressSave = useRef(false);

  // F6: snapshot of the pre-recalc rows, so a recalc that overwrote manual
  // overrides/adjustments can be undone while the period is still open.
  const [undoSnapshot, setUndoSnapshot] = useState<{
    periodId: string;
    rows: unknown[];
  } | null>(null);

  // Warnings
  const [unattributed, setUnattributed] = useState<string[]>([]);
  const [unlinked, setUnlinked] = useState<string[]>([]);
  const [skippedNoRate, setSkippedNoRate] = useState<string[]>([]);

  // Modals
  const [miscRowId, setMiscRowId] = useState<string | null>(null);
  const [showOffCycle, setShowOffCycle] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{
    kind: 'recalculate' | 'deleteAll' | 'unlock' | 'lock';
    message?: string;
    consequence?: string;
    confirmWord?: string;
  } | null>(null);
  const [unlockReason, setUnlockReason] = useState('');

  // Fetch live FX on mount
  useEffect(() => {
    let cancelled = false;
    fetch('https://open.er-api.com/v6/latest/USD')
      .then((r) => r.json())
      .then((d: unknown) => {
        if (cancelled) return;
        const php = (d as Record<string, Record<string, number>>)?.rates?.PHP;
        if (php) {
          setFx(+(+php).toFixed(4));
          const time = (d as Record<string, string>)?.time_last_update_utc?.slice(5, 16) ?? 'today';
          setFxNote(`live rate ${(+php).toFixed(2)} as of ${time}`);
        }
      })
      .catch(() => {
        if (!cancelled) setFxNote("couldn't fetch live rate — using default, editable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // When period start changes, auto-fill end + payDate
  const applyPeriodStart = useCallback((start: string) => {
    const p = periodFor(start);
    setPeriodStart(p.start);
    setPeriodEnd(p.end);
    setPayDate(p.payDate);
  }, []);

  // Load saved draft / snapshot for the current period
  const loadSaved = useCallback(async () => {
    const periodRow = periods.find(
      (p) => p.periodStart === periodStart && p.periodEnd === periodEnd,
    );
    setCurrentPeriod(periodRow ?? null);

    if (!periodRow) {
      setRows(null);
      return;
    }

    const res = await getSavedPayments({ periodId: periodRow.id, companyId });
    if (!res.ok) {
      notify(res.error, { type: 'error' });
      return;
    }
    setRows(res.data.payments.map(toEditableRow));
  }, [companyId, periods, periodStart, periodEnd, notify]);

  useEffect(() => {
    loadSaved();
  }, [loadSaved]);

  // Deep-link from Process & Pay's "Unlock": once the locked period has loaded,
  // open the unlock modal automatically (fires once). Paid periods can't be
  // unlocked here, so we only trigger on `locked`.
  const autoUnlockFired = useRef(false);
  useEffect(() => {
    if (autoUnlock && !autoUnlockFired.current && currentPeriod?.state === 'locked') {
      autoUnlockFired.current = true;
      setConfirmModal({ kind: 'unlock' });
    }
  }, [autoUnlock, currentPeriod]);

  // Calculate
  const handleCalculate = async (skipConfirm = false) => {
    // Show destructive-recalc confirm if there are overrides
    const adjusted = (rows ?? []).filter(
      (r) =>
        r.overridden || r.haPhp > 0 || r.pddPhp > 0 || r.bonusPhp > 0 || r.miscItems.length > 0,
    );
    if (!skipConfirm && adjusted.length > 0) {
      const names =
        adjusted
          .slice(0, 8)
          .map((r) => r.name)
          .join(', ') + (adjusted.length > 8 ? ` +${adjusted.length - 8} more` : '');
      setConfirmModal({
        kind: 'recalculate',
        message: `This period has ${adjusted.length} contractor(s) with manual overrides or adjustments:\n   ${names}`,
        consequence:
          'Recalculating rebuilds every amount from tracked hours only and OVERWRITES those values (allowances reset to 0, overrides and Misc items discarded).',
        confirmWord: 'RECALCULATE',
      });
      return;
    }

    setBusy(true);
    setUnattributed([]);
    setUnlinked([]);
    setSkippedNoRate([]);
    setRows(null);
    try {
      const res = await calculatePeriodDraft({
        companyId,
        periodStart,
        periodEnd,
        payDate,
        includeHealthAllowance: includeHA,
        includeThirteenth: include13,
        fxRate: fx,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error', persistent: true });
        return;
      }
      const { unattributed: ua, unlinkedWorkerIds: ul, skippedNoRate: snr } = res.data;
      setUnattributed(ua);
      setUnlinked(ul);
      setSkippedNoRate(snr);
      // F6: keep the pre-recalc snapshot so the user can undo if this recalc
      // overwrote manual overrides. Only offer it when there was something to lose.
      setUndoSnapshot(
        res.data.priorSnapshot.length > 0
          ? { periodId: res.data.periodId, rows: res.data.priorSnapshot }
          : null,
      );
      if (ua.length > 0 || ul.length > 0 || snr.length > 0) {
        notify('Calculation complete with warnings — see banners above.', {
          type: 'warn',
        });
      } else {
        notify('Calculated successfully.', { type: 'success' });
      }
      // Reload saved rows to reflect the newly persisted draft
      const refreshed = periods;
      setPeriods(refreshed);
      await loadSaved();
    } finally {
      setBusy(false);
    }
  };

  // F6: restore the snapshot captured before the last recalc.
  const handleUndoRecalc = async () => {
    if (!undoSnapshot) return;
    setBusy(true);
    try {
      const res = await restorePaymentsSnapshot({
        companyId,
        periodId: undoSnapshot.periodId,
        snapshot: undoSnapshot.rows,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error', persistent: true });
        return;
      }
      setUndoSnapshot(null);
      notify(`Recalculation undone — restored ${res.data.restored} statement(s).`, {
        type: 'success',
      });
      await loadSaved();
    } finally {
      setBusy(false);
    }
  };

  // Patch a row value and recompute net locally (optimistic); debounced server save
  const patchRow = (workerId: string, patch: Partial<EditableRow>) => {
    setRows(
      (prev) =>
        prev?.map((r) => (r.workerId === workerId ? recomputeRow({ ...r, ...patch }) : r)) ?? null,
    );
  };

  // Per-row save (debounced, 800ms, same as legacy)
  const saveDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!rows?.length || currentPeriod?.state !== 'open') return;
    if (saveDebounce.current) clearTimeout(saveDebounce.current);
    saveDebounce.current = setTimeout(async () => {
      if (suppressSave.current) return;
      // Batch-save all rows
      for (const r of rows) {
        await updatePaymentRowAction({
          paymentId: r.paymentId,
          companyId,
          grossPhpOverride: r.overridden ? r.grossPhp : null,
          haPhp: r.haPhp,
          t13Php: r.t13Php,
          pddPhp: r.pddPhp,
          bonusPhp: r.bonusPhp,
          miscItems: r.miscItems,
          payoutMethod: r.payoutMethod as (typeof PAYOUT_METHODS)[number] | null,
          fxRate: fx,
        });
      }
    }, 800);
    return () => {
      if (saveDebounce.current) clearTimeout(saveDebounce.current);
    };
  }, [rows, companyId, currentPeriod, fx]);

  // Lock & Save
  const handleLock = async () => {
    if (!rows?.length) {
      notify('Calculate first.', { type: 'warn' });
      return;
    }
    setBusy(true);
    try {
      const res = await lockPeriod({ companyId, periodStart, periodEnd });
      if (!res.ok) {
        notify(res.error, { type: 'error', persistent: true });
        return;
      }
      notify(`Locked ${res.data.lockedCount} statement(s).`, {
        type: 'success',
      });
      setCurrentPeriod((p) => (p ? { ...p, state: 'locked' } : null));
      setPeriods((prev) =>
        prev.map((p) =>
          p.periodStart === periodStart && p.periodEnd === periodEnd
            ? { ...p, state: 'locked' }
            : p,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  // Unlock with typed reason
  const handleUnlock = async () => {
    if (!unlockReason.trim()) {
      notify('Unlock requires a reason.', { type: 'warn' });
      return;
    }
    setBusy(true);
    try {
      const res = await unlockPeriod({
        companyId,
        periodStart,
        periodEnd,
        reason: unlockReason,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error', persistent: true });
        return;
      }
      notify('Period unlocked for editing.', { type: 'success' });
      setCurrentPeriod((p) => (p ? { ...p, state: 'open' } : null));
      setPeriods((prev) =>
        prev.map((p) =>
          p.periodStart === periodStart && p.periodEnd === periodEnd ? { ...p, state: 'open' } : p,
        ),
      );
      setConfirmModal(null);
      setUnlockReason('');
    } finally {
      setBusy(false);
    }
  };

  // Delete single statement
  const handleDeleteStatement = async (paymentId: string, name: string) => {
    suppressSave.current = true;
    setBusy(true);
    try {
      const res = await deleteStatement({ paymentId, companyId });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      setRows((prev) => (prev ?? []).filter((r) => r.paymentId !== paymentId));
      notify(`Deleted ${name}'s statement.`, { type: 'success' });
    } finally {
      setBusy(false);
      setTimeout(() => {
        suppressSave.current = false;
      }, 1200);
    }
  };

  // Delete all statements
  const handleDeleteAll = async () => {
    suppressSave.current = true;
    setBusy(true);
    try {
      const res = await deleteAllStatements({
        companyId,
        periodStart,
        periodEnd,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      setRows([]);
      notify(`Deleted ${res.data.deleted} statement(s).`, { type: 'success' });
      setConfirmModal(null);
    } finally {
      setBusy(false);
      setTimeout(() => {
        suppressSave.current = false;
      }, 1200);
    }
  };

  // Misc modal save
  const handleMiscSave = async (workerId: string, payload: MiscModalPayload) => {
    patchRow(workerId, {
      haPhp: payload.haPhp,
      t13Php: payload.t13Php ?? 0,
      pddPhp: payload.pddPhp,
      bonusPhp: payload.bonusPhp,
      miscItems: payload.miscItems,
    });
    setMiscRowId(null);
  };

  // Computed totals
  const totalNetCentavos = (rows ?? []).reduce(
    (s, r) => s + (r.netPhp != null ? Math.round(r.netPhp * 100) : 0),
    0,
  );
  const totalUsdCents = usdReference(centavos(totalNetCentavos), fx);
  const isOpen = !currentPeriod || currentPeriod.state === 'open';
  const isLocked = currentPeriod?.state === 'locked';
  const isPaid = currentPeriod?.state === 'paid';

  // Batch list
  const finishedBatches = periods.filter((p) => p.state === 'locked' || p.state === 'paid');
  const shownBatches = showFinished
    ? periods
    : periods.filter((p) => p.state !== 'locked' && p.state !== 'paid');

  return (
    <div>
      {/* ---- Batch list ---- */}
      <div className="card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 12,
          }}
        >
          <div>
            <h2 style={{ margin: 0 }}>Pay periods</h2>
            <p className="sub" style={{ margin: '4px 0 0' }}>
              {showFinished
                ? 'Every period with statements.'
                : 'Active periods (draft and uncalculated).'}{' '}
              Select a period below to edit it, or use the Calculate card.
            </p>
          </div>
          {finishedBatches.length > 0 && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setShowFinished((s) => !s)}
            >
              {showFinished
                ? `Hide locked/paid (${finishedBatches.length})`
                : `Show locked/paid (${finishedBatches.length})`}
            </button>
          )}
        </div>

        {shownBatches.length === 0 ? (
          <EmptyState>
            No periods to show.{' '}
            {finishedBatches.length > 0
              ? 'Use "Show locked/paid" to see finished periods.'
              : 'Calculate a period below to get started.'}
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Pay date</th>
                  <th>Contractors</th>
                  <th>Net total</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shownBatches.map((b) => {
                  const isCur = b.periodStart === periodStart && b.periodEnd === periodEnd;
                  return (
                    <tr key={b.id} style={isCur ? { background: '#eff6ff' } : undefined}>
                      <td className="card-title">
                        <b>
                          {b.kind === 'off_cycle'
                            ? '⏱ Off-cycle batch'
                            : `${fmtDate(b.periodStart)} – ${fmtDate(b.periodEnd)}`}
                        </b>
                        {b.kind === 'off_cycle' && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            catch-up · added {fmtDate(b.periodStart)}
                          </div>
                        )}
                      </td>
                      <td data-label="Pay date">{fmtDate(b.payDate)}</td>
                      <td data-label="Contractors">{b.contractorCount}</td>
                      <td data-label="Net total">{money(centavosToPhp(b.totalNetCentavos))}</td>
                      <td data-label="State">
                        <Badge tone={periodStateTone(b.state)}>{periodStateLabel(b.state)}</Badge>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={busy}
                          onClick={() => {
                            applyPeriodStart(b.periodStart);
                            // The editor card lives below this list — bring it into
                            // view so the selection is visible (otherwise the click
                            // looks like a no-op, especially for the current period).
                            document
                              .getElementById('pay-batch-card')
                              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                          }}
                        >
                          {b.state === 'open' ? 'Edit' : 'View'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- Warning banners ---- */}
      {(unattributed.length > 0 || unlinked.length > 0 || skippedNoRate.length > 0) && (
        <div className="card">
          {unattributed.length > 0 && (
            <div
              className="banner"
              style={{
                background: '#fef2f2',
                borderColor: '#fecaca',
                color: '#b91c1c',
                marginBottom: 8,
              }}
            >
              <b>⚠ {unattributed.length} approved entr(ies) couldn't be matched to a contractor:</b>{' '}
              {unattributed.slice(0, 8).join(', ')}
              {unattributed.length > 8 ? ` +${unattributed.length - 8} more` : ''}. Link them on the
              Contractors tab, then recalculate.
            </div>
          )}
          {unlinked.length > 0 && (
            <div
              className="banner"
              style={{
                background: '#fef2f2',
                borderColor: '#fecaca',
                color: '#b91c1c',
                marginBottom: 8,
              }}
            >
              <b>
                ⚠ {unlinked.length} contractor(s) have approved time but aren't linked to this
                company.
              </b>
            </div>
          )}
          {skippedNoRate.length > 0 && (
            <div
              className="banner"
              style={{
                background: '#fef3c7',
                borderColor: '#fcd34d',
                color: '#92400e',
              }}
            >
              <b>⚠ {skippedNoRate.length} contractor(s) skipped (no rate):</b>{' '}
              {skippedNoRate.slice(0, 8).join(', ')}
              {skippedNoRate.length > 8 ? ` +${skippedNoRate.length - 8} more` : ''}
            </div>
          )}
        </div>
      )}

      {/* ---- Current period card ---- */}
      <div className="card" id="pay-batch-card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div>
            <h2 style={{ margin: 0 }}>
              Pay batch · {fmtDate(periodStart)} – {fmtDate(periodEnd)}
            </h2>
            {currentPeriod && (
              <p className="sub" style={{ margin: '4px 0 0' }}>
                Pay date <b>{fmtDate(payDate)}</b> · {rows?.length ?? 0} contractor(s) · Payout{' '}
                <b>{money(centavosToPhp(totalNetCentavos))}</b>
                {totalUsdCents != null && (
                  <span className="muted">
                    {' '}
                    (≈ ${(totalUsdCents / 100).toFixed(2)} ref @ {fx} PHP/USD)
                  </span>
                )}
              </p>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            {currentPeriod && currentPeriod.state !== 'open' && (
              <Badge tone={periodStateTone(currentPeriod.state)}>🔒 {currentPeriod.state}</Badge>
            )}
            <button
              type="button"
              className="btn"
              disabled={busy || isPaid}
              onClick={() =>
                setConfirmModal({
                  kind: 'lock',
                  message: `Lock ${rows?.length ?? 0} pay statement(s) for ${periodStart} → ${periodEnd}?`,
                  consequence:
                    'Locking freezes the snapshot for processing. Unlocking later needs a typed reason.',
                  confirmWord: 'LOCK',
                })
              }
            >
              {isLocked ? 'Re-lock batch' : isPaid ? 'Marked paid' : 'Lock batch for processing'}
            </button>
            {(isLocked || isPaid) && (
              <button
                type="button"
                className="btn ghost"
                disabled={busy || isPaid}
                style={{ borderColor: '#b91c1c', color: '#b91c1c' }}
                onClick={() => {
                  if (isPaid) {
                    notify('Period is marked PAID — go to Process & Pay → Mark all unpaid first.', {
                      type: 'warn',
                    });
                    return;
                  }
                  setConfirmModal({ kind: 'unlock' });
                }}
              >
                Unlock for editing…
              </button>
            )}
            {isOpen && rows && rows.length > 0 && (
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
                onClick={() =>
                  setConfirmModal({
                    kind: 'deleteAll',
                    message: `Delete the WHOLE batch — all ${rows.length} pay statement(s) for ${periodStart} → ${periodEnd}?`,
                    consequence:
                      'The period stays open so you can recalculate. No money is affected.',
                    confirmWord: 'DELETE',
                  })
                }
              >
                Delete batch
              </button>
            )}
          </div>
        </div>

        {/* Calculation options */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
            marginBottom: 12,
          }}
        >
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor={idPeriodStart} style={{ fontSize: 13 }}>
              Period start
            </label>
            <input
              id={idPeriodStart}
              type="date"
              value={periodStart}
              onChange={(e) => applyPeriodStart(e.target.value)}
              disabled={busy}
            />
          </div>
          <label style={{ fontSize: 13 }}>
            <input
              type="checkbox"
              checked={includeHA}
              onChange={(e) => setIncludeHA(e.target.checked)}
            />{' '}
            Include Health Allowance
          </label>
          <label style={{ fontSize: 13 }}>
            <input
              type="checkbox"
              checked={include13}
              onChange={(e) => setInclude13(e.target.checked)}
            />{' '}
            Include 13th-month
          </label>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <label htmlFor={idFxRef} style={{ fontSize: 12, color: 'var(--muted)' }}>
              FX ref
            </label>
            <input
              id={idFxRef}
              type="number"
              step="0.0001"
              value={fx}
              onChange={(e) => setFx(Number.parseFloat(e.target.value) || DEFAULT_FX)}
              style={{ width: 90 }}
              aria-label="PHP per USD exchange rate"
            />
          </span>
          {fxNote && (
            <span className="muted" style={{ fontSize: 11 }}>
              {fxNote}
            </span>
          )}
          <button
            type="button"
            className="btn ghost sm"
            disabled={busy}
            onClick={() => handleCalculate()}
          >
            {busy ? 'Working…' : 'Calculate / Recalculate'}
          </button>
          {isOpen && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() => setShowOffCycle(true)}
              title="Add a session for a per-session contractor, or pay approved sessions dated outside this period"
            >
              + Sessions
            </button>
          )}
          {undoSnapshot && currentPeriod?.state === 'open' && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={handleUndoRecalc}
              title="Restore the statements as they were before the last recalculation, including manual overrides and adjustments."
            >
              ↩ Undo recalculation
            </button>
          )}
        </div>

        {/* Draft table */}
        {rows === null && !busy && (
          <EmptyState>
            No saved draft for this period. Press <b>Calculate</b> to build one from approved time.
          </EmptyState>
        )}
        {busy && (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Spinner />
          </div>
        )}
        {rows !== null && !busy && rows.length === 0 && (
          <EmptyState>No statements. Recalculate to rebuild.</EmptyState>
        )}
        {rows !== null && !busy && rows.length > 0 && (
          <>
            <div className="table-scroll keep-table">
              <table>
                <thead>
                  <tr>
                    <th>Contractor</th>
                    <th>Worked h</th>
                    <th>Exp h</th>
                    <th>Ratio</th>
                    <th>Rate ₱</th>
                    <th>Gross ₱</th>
                    <th>HA ₱</th>
                    <th>13th ₱</th>
                    <th>Lunch ₱</th>
                    <th>Bonus ₱</th>
                    <th>Misc ₱</th>
                    <th>Net ₱</th>
                    <th>≈ USD</th>
                    <th>Via</th>
                    {isOpen && <th />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const usdRef = usdReference(
                      r.netPhp != null ? centavos(Math.round(r.netPhp * 100)) : null,
                      fx,
                    );
                    const miscSum = r.miscItems.reduce((s, it) => {
                      const a = Number(it.amount) || 0;
                      return s + (it.kind === 'deduction' ? -a : a);
                    }, 0);
                    return (
                      <tr
                        key={r.workerId}
                        style={
                          r.inactive
                            ? { background: '#fef2f2' }
                            : r.ratePhp == null
                              ? { background: 'var(--warn-soft)' }
                              : undefined
                        }
                      >
                        <td className="card-title">
                          <b style={r.inactive ? { textDecoration: 'line-through' } : undefined}>
                            {r.name}
                          </b>
                          {r.inactive && (
                            <Badge tone="bad" style={{ marginLeft: 6, fontSize: 10 }}>
                              🚫 inactive
                            </Badge>
                          )}
                        </td>
                        <td data-label="Worked h">{r.workedHours.toFixed(2)}</td>
                        <td data-label="Exp h">{r.expectedHours}</td>
                        <td data-label="Ratio">{(r.ratio * 100).toFixed(0)}%</td>
                        <td data-label="Rate ₱">
                          {r.ratePhp == null ? (
                            <span className="muted">no rate</span>
                          ) : (
                            r.ratePhp.toLocaleString('en-US')
                          )}
                        </td>
                        <td data-label="Gross ₱">
                          {isOpen ? (
                            <>
                              <input
                                type="number"
                                step="0.01"
                                value={r.grossPhp ?? ''}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  const overridden = val !== '' && val != null;
                                  patchRow(r.workerId, {
                                    grossPhp: overridden
                                      ? Number.parseFloat(val)
                                      : r.computedGrossPhp,
                                    overridden,
                                  });
                                }}
                                style={{
                                  width: 90,
                                  padding: '3px 6px',
                                  fontSize: 13,
                                  border: r.overridden
                                    ? '1px solid var(--accent)'
                                    : '1px solid var(--border)',
                                  background: r.overridden ? 'var(--accent-soft)' : '#fff',
                                }}
                              />
                              {r.overridden && (
                                <button
                                  type="button"
                                  className="btn ghost sm"
                                  style={{ marginLeft: 4, padding: '2px 6px' }}
                                  title="Revert to computed"
                                  aria-label="Revert to computed value"
                                  onClick={() =>
                                    patchRow(r.workerId, {
                                      grossPhp: r.computedGrossPhp,
                                      overridden: false,
                                    })
                                  }
                                >
                                  ↺
                                </button>
                              )}
                            </>
                          ) : (
                            (r.grossPhp?.toLocaleString('en-US') ?? '—')
                          )}
                        </td>
                        <td data-label="HA ₱">{r.haPhp ? r.haPhp.toLocaleString('en-US') : '—'}</td>
                        <td data-label="13th ₱">
                          {r.t13Php ? r.t13Php.toLocaleString('en-US') : '—'}
                        </td>
                        <td data-label="Lunch ₱">
                          {r.pddPhp ? r.pddPhp.toLocaleString('en-US') : '—'}
                        </td>
                        <td data-label="Bonus ₱">
                          {r.bonusPhp ? r.bonusPhp.toLocaleString('en-US') : '—'}
                        </td>
                        <td data-label="Misc ₱" style={{ whiteSpace: 'nowrap' }}>
                          <span
                            style={{
                              display: 'inline-flex',
                              gap: 6,
                              alignItems: 'center',
                            }}
                          >
                            {Math.abs(miscSum) > 0.005 ? (
                              <span
                                style={{
                                  color: miscSum < 0 ? '#b91c1c' : 'inherit',
                                }}
                              >
                                {miscSum < 0 ? '-' : ''}
                                {Math.abs(miscSum).toLocaleString('en-US', {
                                  minimumFractionDigits: 2,
                                })}
                              </span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                            {isOpen && (
                              <button
                                type="button"
                                className="btn ghost sm"
                                style={{ padding: '2px 8px', fontSize: 12 }}
                                onClick={() => setMiscRowId(r.workerId)}
                                title={
                                  r.miscItems.length
                                    ? `Edit ${r.miscItems.length} misc item(s)`
                                    : 'Add Misc items'
                                }
                              >
                                {r.miscItems.length ? `Edit (${r.miscItems.length})` : '+ Misc'}
                              </button>
                            )}
                          </span>
                        </td>
                        <td data-label="Net ₱">
                          <b>{r.netPhp == null ? '—' : r.netPhp.toLocaleString('en-US')}</b>
                          {r.offCyclePhp > 0 && (
                            <div
                              className="muted"
                              style={{ fontSize: 11 }}
                              title="Includes off-cycle per-session / per-hour pay"
                            >
                              incl. off-cycle ₱
                              {r.offCyclePhp.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                            </div>
                          )}
                        </td>
                        <td className="muted" data-label="≈ USD">
                          {usdRef == null
                            ? '—'
                            : `$${(usdRef / 100).toLocaleString('en-US', {
                                minimumFractionDigits: 2,
                              })}`}
                        </td>
                        <td data-label="Via">
                          {isOpen ? (
                            <select
                              value={r.payoutMethod ?? ''}
                              onChange={(e) =>
                                patchRow(r.workerId, {
                                  payoutMethod: e.target.value || null,
                                })
                              }
                              style={{
                                padding: '3px 6px',
                                fontSize: 13,
                                border: r.payoutMethod
                                  ? '1px solid var(--border)'
                                  : '1px solid var(--warn)',
                                background: r.payoutMethod ? '#fff' : 'var(--warn-soft)',
                              }}
                            >
                              <option value="">— set —</option>
                              {PAYOUT_METHODS.map((m) => (
                                <option key={m} value={m}>
                                  {payoutMethodLabel(m)}
                                </option>
                              ))}
                            </select>
                          ) : (
                            payoutMethodLabel(r.payoutMethod)
                          )}
                        </td>
                        {isOpen && (
                          <td style={{ textAlign: 'right' }}>
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={busy}
                              style={{
                                borderColor: 'var(--bad)',
                                color: 'var(--bad)',
                                padding: '2px 8px',
                              }}
                              onClick={() => handleDeleteStatement(r.paymentId, r.name)}
                            >
                              Delete
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={11} style={{ textAlign: 'right', fontWeight: 600 }}>
                      Total
                    </td>
                    <td>
                      <b>{money(centavosToPhp(totalNetCentavos))}</b>
                    </td>
                    <td />
                    <td />
                    {isOpen && <td />}
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              Contractors are <b>paid in PHP</b> (Net ₱). USD is a reference only (Net ÷ FX).{' '}
              <b>Gross ₱ is editable</b> — a blue cell marks an override. Yellow rows have no
              effective rate.
            </p>
          </>
        )}
      </div>

      {/* ---- Modals ---- */}

      {miscRowId !== null &&
        (() => {
          const row = (rows ?? []).find((r) => r.workerId === miscRowId);
          if (!row) {
            setMiscRowId(null);
            return null;
          }
          return (
            <MiscModal
              name={row.name}
              ratePhp={row.ratePhp}
              haPhp={row.haPhp}
              t13Php={row.t13Php}
              computedT13Php={row.computedT13Php}
              pddPhp={row.pddPhp}
              bonusPhp={row.bonusPhp}
              miscItems={row.miscItems}
              onSave={(payload) => handleMiscSave(row.workerId, payload)}
              onClose={() => setMiscRowId(null)}
            />
          );
        })()}

      {showOffCycle && (
        <OffCycleModal
          companyId={companyId}
          periodStart={periodStart}
          periodEnd={periodEnd}
          periodId={currentPeriod?.id ?? null}
          onClose={() => setShowOffCycle(false)}
          onSaved={() => {
            loadSaved();
          }}
        />
      )}

      {confirmModal?.kind === 'recalculate' && (
        <ConfirmDangerModal
          title="Recalculate from tracked hours?"
          message={confirmModal.message}
          consequence={confirmModal.consequence}
          confirmWord={confirmModal.confirmWord}
          confirmLabel="Recalculate & overwrite"
          busy={busy}
          onConfirm={() => {
            setConfirmModal(null);
            handleCalculate(true);
          }}
          onCancel={() => setConfirmModal(null)}
        />
      )}

      {confirmModal?.kind === 'lock' && (
        <ConfirmDangerModal
          title="Lock this pay batch?"
          message={confirmModal.message}
          consequence={confirmModal.consequence}
          confirmWord={confirmModal.confirmWord}
          confirmLabel="Lock batch"
          busy={busy}
          onConfirm={() => {
            setConfirmModal(null);
            handleLock();
          }}
          onCancel={() => setConfirmModal(null)}
        />
      )}

      {confirmModal?.kind === 'deleteAll' && (
        <ConfirmDangerModal
          title="Delete this batch?"
          message={confirmModal.message}
          consequence={confirmModal.consequence}
          confirmWord={confirmModal.confirmWord}
          confirmLabel="Delete all statements"
          busy={busy}
          onConfirm={handleDeleteAll}
          onCancel={() => setConfirmModal(null)}
        />
      )}

      {confirmModal?.kind === 'unlock' && (
        <>
          {/* Reason field shown before the modal so user fills it before confirming */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: overlay only stops event propagation; it exposes no action and adds no keyboard semantics. */}
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 49,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0,0,0,0.45)',
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {/* biome-ignore lint/a11y/noStaticElementInteractions: card only stops event propagation; it exposes no action and adds no keyboard semantics. */}
            <div
              className="card"
              style={{ width: '100%', maxWidth: 480, zIndex: 50, margin: 16 }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <h3 style={{ marginTop: 0 }}>Unlock period for editing?</h3>
              <p>
                Period:{' '}
                <b>
                  {periodStart} → {periodEnd}
                </b>
              </p>
              <div
                style={{
                  background: '#fef3c7',
                  border: '1px solid #fcd34d',
                  borderRadius: 6,
                  padding: '10px 14px',
                  marginBottom: 12,
                  fontSize: 13,
                }}
              >
                Recalculating after unlock will REBUILD net amounts from hours — manual overrides
                (gross, PDD lunch, 13th, bonus) will be wiped. Re-lock when done.
              </div>
              <div className="field">
                <label htmlFor="unlock-reason">Reason (required — typed text enables Unlock)</label>
                <input
                  id="unlock-reason"
                  value={unlockReason}
                  onChange={(e) => setUnlockReason(e.target.value)}
                  placeholder="e.g. Rate correction for Maria Santos"
                />
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  justifyContent: 'flex-end',
                  marginTop: 12,
                }}
              >
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => {
                    setConfirmModal(null);
                    setUnlockReason('');
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{
                    background: '#b91c1c',
                    color: '#fff',
                    borderColor: '#b91c1c',
                  }}
                  disabled={busy || !unlockReason.trim()}
                  onClick={handleUnlock}
                >
                  {busy ? 'Unlocking…' : 'Unlock'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
