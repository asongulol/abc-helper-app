'use client';

/**
 * ProcessShell — client shell for the /process page.
 * Shows locked/paid periods, payment rows with status pills, Wise section
 * (owner-gated), bank/BPI export, mark paid/unpaid, and row-level wise-lock.
 */

import { Badge } from '@/components/ui/Badge';
import { ConfirmDangerModal } from '@/components/ui/ConfirmDangerModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import type { PeriodSummaryRow, ProcessPayment } from '@/db/queries/payroll';
import { fmtDate, fmtDateTime, money } from '@/lib/format';
import { buildBankExport, downloadCsv } from '@/lib/payroll/bank-export';
import {
  paymentStatusLabel,
  paymentStatusTone,
  payoutMethodLabel,
  periodStateLabel,
  periodStateTone,
} from '@/lib/payroll/status-pills';
import {
  getProcessPayments,
  markAllUnpaid,
  markPaid,
  markUnpaid,
  toggleWiseRowLock,
  unlockPeriod,
} from '@/server/actions/payroll';
import { wiseBatch, wiseDraft, wiseMatch, wisePoll } from '@/server/actions/wise';
import { useCallback, useState } from 'react';

interface ProcessShellProps {
  companyId: string;
  isOwner: boolean;
  initialPeriods: PeriodSummaryRow[];
}

type ConfirmKind = 'markPaid' | 'markUnpaid' | 'markAllUnpaid' | 'unlockPeriod' | 'wiseUnlockRow';

type ConfirmState = {
  kind: ConfirmKind;
  title: string;
  message: string;
  consequence?: string;
  confirmWord?: string;
  confirmLabel: string;
  paymentIds?: string[];
  paymentId?: string;
  reason?: string;
};

export const ProcessShell = ({ companyId, isOwner, initialPeriods }: ProcessShellProps) => {
  const { notify } = useToast();
  const [periods] = useState<PeriodSummaryRow[]>(initialPeriods);
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(
    initialPeriods[0]?.id ?? null,
  );
  const [payments, setPayments] = useState<ProcessPayment[] | null>(null);
  const [loadingPayments, setLoadingPayments] = useState(false);
  const [busy, setBusy] = useState(false);

  // Confirm modal state
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [confirmReason, setConfirmReason] = useState('');
  const [selectedPaymentIds, setSelectedPaymentIds] = useState<Set<string>>(new Set());

  // Row-level wise unlock input
  const [wiseUnlockRowId, setWiseUnlockRowId] = useState<string | null>(null);
  const [wiseUnlockReason, setWiseUnlockReason] = useState('');

  const selectedPeriod = periods.find((p) => p.id === selectedPeriodId) ?? null;

  const loadPayments = useCallback(
    async (periodId: string) => {
      setLoadingPayments(true);
      setPayments(null);
      setSelectedPaymentIds(new Set());
      try {
        const res = await getProcessPayments({ periodId, companyId });
        if (!res.ok) {
          notify(res.error, { type: 'error' });
          return;
        }
        setPayments(res.data.payments);
      } finally {
        setLoadingPayments(false);
      }
    },
    [companyId, notify],
  );

  const handleSelectPeriod = (periodId: string) => {
    setSelectedPeriodId(periodId);
    loadPayments(periodId);
  };

  // Toggle row selection
  const toggleSelect = (id: string) => {
    setSelectedPaymentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    const ids = (payments ?? []).filter((p) => !p.wiseLockedAt).map((p) => p.paymentId);
    setSelectedPaymentIds(new Set(ids));
  };

  const selectNone = () => setSelectedPaymentIds(new Set());

  // Mark paid (selected rows)
  const doMarkPaid = async (paymentIds: string[]) => {
    setBusy(true);
    try {
      const res = await markPaid({ paymentIds, companyId });
      if (!res.ok) {
        notify(res.error, { type: 'error', persistent: true });
        return;
      }
      notify(`Marked ${res.data.markedCount} payment(s) as paid.`, { type: 'success' });
      setPayments((prev) =>
        (prev ?? []).map((p) =>
          paymentIds.includes(p.paymentId)
            ? { ...p, status: 'sent', paidAt: new Date().toISOString() }
            : p,
        ),
      );
      setSelectedPaymentIds(new Set());
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  // Mark unpaid (selected rows)
  const doMarkUnpaid = async (paymentIds: string[]) => {
    setBusy(true);
    try {
      const res = await markUnpaid({ paymentIds, companyId });
      if (!res.ok) {
        notify(res.error, { type: 'error', persistent: true });
        return;
      }
      notify(`Marked ${res.data.markedCount} payment(s) as unpaid.`, { type: 'success' });
      setPayments((prev) =>
        (prev ?? []).map((p) =>
          paymentIds.includes(p.paymentId) ? { ...p, status: 'draft', paidAt: null } : p,
        ),
      );
      setSelectedPaymentIds(new Set());
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  // Mark all unpaid (full period reset, non-wise-transfer rows only)
  const doMarkAllUnpaid = async () => {
    if (!selectedPeriodId) return;
    setBusy(true);
    try {
      const res = await markAllUnpaid({ periodId: selectedPeriodId, companyId });
      if (!res.ok) {
        notify(res.error, { type: 'error', persistent: true });
        return;
      }
      notify(`Reset ${res.data.markedCount} payment(s) to unpaid. Period stepped back to locked.`, {
        type: 'success',
      });
      // Reload
      await loadPayments(selectedPeriodId);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  // Unlock period from process screen
  const doUnlockPeriod = async (reason: string) => {
    if (!selectedPeriod) return;
    setBusy(true);
    try {
      const res = await unlockPeriod({
        companyId,
        periodStart: selectedPeriod.periodStart,
        periodEnd: selectedPeriod.periodEnd,
        reason,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error', persistent: true });
        return;
      }
      notify('Period unlocked — go to Payroll to edit statements.', { type: 'success' });
      setConfirm(null);
      setConfirmReason('');
    } finally {
      setBusy(false);
    }
  };

  // Wise row lock toggle
  const doWiseUnlockRow = async (paymentId: string, reason: string) => {
    setBusy(true);
    try {
      const res = await toggleWiseRowLock({ paymentId, companyId, lockedAt: null, reason });
      if (!res.ok) {
        notify(res.error, { type: 'error', persistent: true });
        return;
      }
      notify('Wise row unlocked.', { type: 'success' });
      setPayments((prev) =>
        (prev ?? []).map((p) =>
          p.paymentId === paymentId ? { ...p, wiseLockedAt: res.data.lockedAt } : p,
        ),
      );
      setWiseUnlockRowId(null);
      setWiseUnlockReason('');
    } finally {
      setBusy(false);
    }
  };

  // Wise lock a row (no reason needed — locks optimistically)
  const doWiseLockRow = async (paymentId: string) => {
    setBusy(true);
    try {
      const lockedAt = new Date().toISOString();
      const res = await toggleWiseRowLock({ paymentId, companyId, lockedAt });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify('Row locked in Wise.', { type: 'success' });
      setPayments((prev) =>
        (prev ?? []).map((p) =>
          p.paymentId === paymentId ? { ...p, wiseLockedAt: res.data.lockedAt } : p,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  // Wise actions — all wrapped in try/catch; they currently throw notWired
  // NOTE: Wise signatures take raw arrays / no args (see src/server/actions/wise.ts).
  // All transfers are DRAFTS only — never fund via this app.
  const callWiseDraft = async () => {
    if (!payments?.length) {
      notify('No payments loaded.', { type: 'warn' });
      return;
    }
    setBusy(true);
    try {
      const ids = payments.filter((p) => p.payoutMethod === 'wise').map((p) => p.paymentId);
      if (ids.length === 0) {
        notify('No Wise-method payments found.', { type: 'warn' });
        return;
      }
      const res = await wiseDraft(ids);
      if (!res.ok) {
        notify(`Wise draft error: ${res.error}`, { type: 'error', persistent: true });
        return;
      }
      notify('Wise drafts created. Review in Wise before funding manually.', { type: 'success' });
    } catch (e: unknown) {
      notify(`Wise is not wired yet: ${e instanceof Error ? e.message : String(e)}`, {
        type: 'error',
        persistent: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const callWiseBatch = async () => {
    if (!payments?.length) {
      notify('No payments loaded.', { type: 'warn' });
      return;
    }
    setBusy(true);
    try {
      const ids = payments.filter((p) => p.payoutMethod === 'wise').map((p) => p.paymentId);
      if (ids.length === 0) {
        notify('No Wise-method payments found.', { type: 'warn' });
        return;
      }
      const res = await wiseBatch(ids);
      if (!res.ok) {
        notify(`Wise batch error: ${res.error}`, { type: 'error', persistent: true });
        return;
      }
      notify(
        'Wise batch queued. Fund the batch manually in Wise — do NOT trigger payment via this app.',
        {
          type: 'success',
          persistent: true,
        },
      );
    } catch (e: unknown) {
      notify(`Wise is not wired yet: ${e instanceof Error ? e.message : String(e)}`, {
        type: 'error',
        persistent: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const callWisePoll = async () => {
    if (!selectedPeriodId) return;
    setBusy(true);
    try {
      // wisePoll() takes no arguments — it reconciles globally
      const res = await wisePoll();
      if (!res.ok) {
        notify(`Wise poll error: ${res.error}`, { type: 'error' });
        return;
      }
      notify(`Wise statuses updated (checked ${res.data.checked}, updated ${res.data.updated}).`, {
        type: 'success',
      });
      await loadPayments(selectedPeriodId);
    } catch (e: unknown) {
      notify(`Wise is not wired yet: ${e instanceof Error ? e.message : String(e)}`, {
        type: 'error',
        persistent: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const callWiseMatch = async () => {
    if (!selectedPeriod) return;
    setBusy(true);
    try {
      const res = await wiseMatch({
        periodStart: selectedPeriod.periodStart,
        periodEnd: selectedPeriod.periodEnd,
      });
      if (!res.ok) {
        notify(`Wise match error: ${res.error}`, { type: 'error' });
        return;
      }
      notify(`Wise transfer IDs matched (${res.data.matched}).`, { type: 'success' });
      await loadPayments(selectedPeriod.id);
    } catch (e: unknown) {
      notify(`Wise is not wired yet: ${e instanceof Error ? e.message : String(e)}`, {
        type: 'error',
        persistent: true,
      });
    } finally {
      setBusy(false);
    }
  };

  // Bank/BPI CSV export
  const handleBankExport = () => {
    if (!payments?.length || !selectedPeriod) {
      notify('No payments to export.', { type: 'warn' });
      return;
    }
    const rows = payments
      .filter((p) => p.payoutMethod !== 'wise')
      .map((p) => ({
        name: p.name,
        netPhp: p.netPhp ?? 0,
        payoutMethod: p.payoutMethod,
      }));
    if (rows.length === 0) {
      notify('No non-Wise rows to export for this period.', { type: 'warn' });
      return;
    }
    const { csv, filename } = buildBankExport(rows, {
      periodStart: selectedPeriod.periodStart,
      periodEnd: selectedPeriod.periodEnd,
    });
    downloadCsv(csv, filename);
    notify(`Exported ${rows.length} rows to ${filename}.`, { type: 'success' });
  };

  // Derived helpers
  const wisePayments = (payments ?? []).filter((p) => p.payoutMethod === 'wise');
  const nonWisePayments = (payments ?? []).filter((p) => p.payoutMethod !== 'wise');
  const selectedArr = Array.from(selectedPaymentIds);
  const allSelected =
    (payments ?? []).filter((p) => !p.wiseLockedAt).length > 0 &&
    (payments ?? [])
      .filter((p) => !p.wiseLockedAt)
      .every((p) => selectedPaymentIds.has(p.paymentId));

  return (
    <div>
      {/* ---- Period selector ---- */}
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
            <h2 style={{ margin: 0 }}>Process &amp; Pay</h2>
            <p className="sub" style={{ margin: '4px 0 0' }}>
              Locked or paid pay periods. Select one to view and process payments.
            </p>
          </div>
        </div>

        {periods.length === 0 ? (
          <EmptyState>
            No locked or paid periods yet. Lock a period in <b>Payroll</b> first.
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
                {periods.map((p) => {
                  const isSelected = p.id === selectedPeriodId;
                  return (
                    <tr key={p.id} style={isSelected ? { background: '#eff6ff' } : undefined}>
                      <td className="card-title">
                        <b>
                          {fmtDate(p.periodStart)} – {fmtDate(p.periodEnd)}
                        </b>
                      </td>
                      <td data-label="Pay date">{fmtDate(p.payDate)}</td>
                      <td data-label="Contractors">{p.contractorCount}</td>
                      <td data-label="Net total">{money(p.totalNetCentavos / 100)}</td>
                      <td data-label="State">
                        <Badge tone={periodStateTone(p.state)}>{periodStateLabel(p.state)}</Badge>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={loadingPayments}
                          onClick={() => handleSelectPeriod(p.id)}
                        >
                          {isSelected ? 'Reload' : 'Open'}
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

      {/* ---- Payment details panel ---- */}
      {selectedPeriod && (
        <div className="card">
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
                {fmtDate(selectedPeriod.periodStart)} – {fmtDate(selectedPeriod.periodEnd)}
              </h2>
              <p className="sub" style={{ margin: '4px 0 0' }}>
                Pay date <b>{fmtDate(selectedPeriod.payDate)}</b> ·{' '}
                <Badge tone={periodStateTone(selectedPeriod.state)}>
                  {periodStateLabel(selectedPeriod.state)}
                </Badge>
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {selectedPeriod.state !== 'paid' && (
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ borderColor: '#b91c1c', color: '#b91c1c' }}
                  disabled={busy}
                  onClick={() =>
                    setConfirm({
                      kind: 'unlockPeriod',
                      title: 'Unlock period for editing?',
                      message: `Period: ${selectedPeriod.periodStart} → ${selectedPeriod.periodEnd}\n\nEnter a reason (recorded in the audit log).`,
                      consequence:
                        'The period returns to "open" state. Go to Payroll to edit statements, then re-lock.',
                      confirmLabel: 'Unlock period',
                    })
                  }
                >
                  Unlock for editing…
                </button>
              )}
            </div>
          </div>

          {/* ---- Bulk actions toolbar ---- */}
          {payments && payments.length > 0 && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                alignItems: 'center',
                marginBottom: 12,
                padding: '8px 12px',
                background: 'var(--surface2)',
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              <label>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => (allSelected ? selectNone() : selectAll())}
                />{' '}
                Select all non-locked ({payments.filter((p) => !p.wiseLockedAt).length})
              </label>
              <span className="muted">
                {selectedArr.length > 0 ? `${selectedArr.length} selected` : 'None selected'}
              </span>
              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn sm"
                  disabled={selectedArr.length === 0 || busy}
                  onClick={() => {
                    const names = (payments ?? [])
                      .filter((p) => selectedArr.includes(p.paymentId))
                      .map((p) => p.name)
                      .slice(0, 6)
                      .join(', ');
                    setConfirm({
                      kind: 'markPaid',
                      title: `Mark ${selectedArr.length} payment(s) as paid?`,
                      message: `${names}${(payments ?? []).filter((p) => selectedArr.includes(p.paymentId)).length > 6 ? ' …' : ''}\n\nThis sets status to "sent" and records paid_at = now().`,
                      confirmLabel: 'Mark paid',
                      paymentIds: selectedArr,
                    });
                  }}
                >
                  Mark paid
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={selectedArr.length === 0 || busy}
                  onClick={() => {
                    setConfirm({
                      kind: 'markUnpaid',
                      title: `Mark ${selectedArr.length} payment(s) as unpaid?`,
                      message: 'This reverts status to "draft" and clears paid_at.',
                      confirmLabel: 'Mark unpaid',
                      paymentIds: selectedArr,
                    });
                  }}
                >
                  Mark unpaid
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
                  onClick={() =>
                    setConfirm({
                      kind: 'markAllUnpaid',
                      title: 'Reset ALL payments to unpaid?',
                      message: `All non-Wise-transfer rows for ${selectedPeriod.periodStart} → ${selectedPeriod.periodEnd} will be reset. Wise-locked rows are skipped. The period steps back to "locked".`,
                      consequence:
                        'Existing paid_at timestamps are cleared. Cannot be undone easily.',
                      confirmWord: 'RESET',
                      confirmLabel: 'Reset all unpaid',
                    })
                  }
                >
                  All unpaid…
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={handleBankExport}
                >
                  Export BPI/bank CSV
                </button>
              </div>
            </div>
          )}

          {/* ---- Wise section (owner-gated) ---- */}
          {isOwner && wisePayments.length > 0 && (
            <div
              style={{
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '12px 16px',
                marginBottom: 16,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <b style={{ fontSize: 14 }}>Wise transfers ({wisePayments.length} rows)</b>
                <span
                  className="muted"
                  style={{
                    fontSize: 12,
                    background: '#fef3c7',
                    padding: '2px 8px',
                    borderRadius: 4,
                  }}
                >
                  DRAFTS only — fund manually in Wise dashboard
                </span>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
                These actions create transfer <b>drafts</b> in Wise. You must fund the batch
                manually inside the Wise dashboard. Do NOT trigger payment via this app.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={callWiseDraft}
                >
                  Draft transfers
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={callWiseBatch}
                >
                  Batch (all Wise rows)
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={callWisePoll}
                >
                  Check statuses
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={callWiseMatch}
                >
                  Match missing transfers
                </button>
              </div>
            </div>
          )}

          {/* ---- Payments table ---- */}
          {loadingPayments ? (
            <div style={{ textAlign: 'center', padding: 32 }}>
              <Spinner />
            </div>
          ) : payments === null ? (
            <EmptyState>Select a period to load payments.</EmptyState>
          ) : payments.length === 0 ? (
            <EmptyState>No payments found for this period.</EmptyState>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 32 }} />
                    <th>Contractor</th>
                    <th>Status</th>
                    <th>Via</th>
                    <th>Net PHP</th>
                    <th>Wise transfer ID</th>
                    <th>Paid at</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => {
                    const isWiseLocked = !!p.wiseLockedAt;
                    const isUnlockingThis = wiseUnlockRowId === p.paymentId;
                    return (
                      <tr
                        key={p.paymentId}
                        style={
                          p.workerStatus === 'inactive'
                            ? { background: '#fef2f2' }
                            : isWiseLocked
                              ? { background: '#f0fdf4' }
                              : undefined
                        }
                      >
                        <td>
                          {!isWiseLocked && (
                            <input
                              type="checkbox"
                              checked={selectedPaymentIds.has(p.paymentId)}
                              onChange={() => toggleSelect(p.paymentId)}
                            />
                          )}
                        </td>
                        <td className="card-title">
                          <b>{p.name}</b>
                          {p.workerStatus === 'inactive' && (
                            <Badge tone="bad" style={{ marginLeft: 6, fontSize: 10 }}>
                              inactive
                            </Badge>
                          )}
                          {isWiseLocked && (
                            <Badge tone="good" style={{ marginLeft: 6, fontSize: 10 }}>
                              Wise locked
                            </Badge>
                          )}
                        </td>
                        <td data-label="Status">
                          <Badge tone={paymentStatusTone(p.status)}>
                            {paymentStatusLabel(p.status)}
                          </Badge>
                        </td>
                        <td data-label="Via">{payoutMethodLabel(p.payoutMethod)}</td>
                        <td data-label="Net PHP">
                          <b>{p.netPhp != null ? money(p.netPhp) : '—'}</b>
                        </td>
                        <td
                          data-label="Wise transfer ID"
                          className="muted"
                          style={{ fontSize: 12 }}
                        >
                          {p.wiseTransferId ? (
                            <span style={{ fontFamily: 'monospace' }}>{p.wiseTransferId}</span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td data-label="Paid at" className="muted" style={{ fontSize: 12 }}>
                          {p.paidAt ? fmtDateTime(p.paidAt) : '—'}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {/* Row-level Wise lock/unlock controls */}
                          {isOwner &&
                            p.payoutMethod === 'wise' &&
                            (isWiseLocked ? (
                              isUnlockingThis ? (
                                <span
                                  style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}
                                >
                                  <input
                                    type="text"
                                    value={wiseUnlockReason}
                                    onChange={(e) => setWiseUnlockReason(e.target.value)}
                                    placeholder="Unlock reason…"
                                    style={{ width: 140, padding: '3px 6px', fontSize: 12 }}
                                  />
                                  <button
                                    type="button"
                                    className="btn sm"
                                    disabled={busy || !wiseUnlockReason.trim()}
                                    onClick={() => doWiseUnlockRow(p.paymentId, wiseUnlockReason)}
                                    style={{ fontSize: 12 }}
                                  >
                                    Unlock
                                  </button>
                                  <button
                                    type="button"
                                    className="btn ghost sm"
                                    onClick={() => {
                                      setWiseUnlockRowId(null);
                                      setWiseUnlockReason('');
                                    }}
                                    style={{ fontSize: 12 }}
                                  >
                                    Cancel
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="btn ghost sm"
                                  disabled={busy}
                                  style={{ fontSize: 12 }}
                                  onClick={() => {
                                    setWiseUnlockRowId(p.paymentId);
                                    setWiseUnlockReason('');
                                  }}
                                >
                                  Unlock row…
                                </button>
                              )
                            ) : (
                              <button
                                type="button"
                                className="btn ghost sm"
                                disabled={busy}
                                style={{ fontSize: 12 }}
                                onClick={() => doWiseLockRow(p.paymentId)}
                              >
                                Lock row
                              </button>
                            ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'right', fontWeight: 600 }}>
                      Total
                    </td>
                    <td>
                      <b>{money((payments ?? []).reduce((s, p) => s + (p.netPhp ?? 0), 0))}</b>
                    </td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Non-wise summary */}
          {nonWisePayments.length > 0 && (
            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              {nonWisePayments.length} non-Wise payment(s) —{' '}
              <button
                type="button"
                className="link"
                onClick={handleBankExport}
                style={{
                  fontSize: 12,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  color: 'var(--accent)',
                  padding: 0,
                }}
              >
                export as BPI/bank CSV
              </button>
            </p>
          )}
        </div>
      )}

      {/* ---- Confirm modal (non-unlock) ---- */}
      {confirm && confirm.kind !== 'unlockPeriod' && (
        <ConfirmDangerModal
          title={confirm.title}
          message={confirm.message}
          consequence={confirm.consequence}
          confirmWord={confirm.confirmWord}
          confirmLabel={confirm.confirmLabel}
          busy={busy}
          onConfirm={async () => {
            if (confirm.kind === 'markPaid' && confirm.paymentIds) {
              await doMarkPaid(confirm.paymentIds);
            } else if (confirm.kind === 'markUnpaid' && confirm.paymentIds) {
              await doMarkUnpaid(confirm.paymentIds);
            } else if (confirm.kind === 'markAllUnpaid') {
              await doMarkAllUnpaid();
            }
          }}
          onCancel={() => {
            setConfirm(null);
            setConfirmReason('');
          }}
        />
      )}

      {/* ---- Unlock period modal (inline — requires typed reason) ---- */}
      {confirm?.kind === 'unlockPeriod' && (
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
          <div
            className="card"
            style={{ width: '100%', maxWidth: 480, zIndex: 50, margin: 16 }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>{confirm.title}</h3>
            <p style={{ whiteSpace: 'pre-line' }}>{confirm.message}</p>
            {confirm.consequence && (
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
                {confirm.consequence}
              </div>
            )}
            <div className="field">
              <label htmlFor="process-unlock-reason">
                Reason (required — enables unlock button)
              </label>
              <input
                id="process-unlock-reason"
                value={confirmReason}
                onChange={(e) => setConfirmReason(e.target.value)}
                placeholder="e.g. Rate correction for Maria Santos"
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                onClick={() => {
                  setConfirm(null);
                  setConfirmReason('');
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                style={{ background: '#b91c1c', color: '#fff', borderColor: '#b91c1c' }}
                disabled={busy || !confirmReason.trim()}
                onClick={() => doUnlockPeriod(confirmReason)}
              >
                {busy ? 'Unlocking…' : confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
