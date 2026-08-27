'use client';

/**
 * Time Approval Table — the interactive contractor-grouped grid.
 *
 * Features:
 * - Per-contractor rows: tracked / PTO / total hours, approval status
 * - Approve / reject per-contractor; approve-all-pending bulk action
 * - Edit-total (inline overwrite of period total → first day)
 * - Per-row "Add hours" expansion panel (AddHoursPanel)
 * - Bottom "add unlisted contractor" row (AddUnlistedRow)
 * - Unmatched source_names banner
 *
 * Faithful to the legacy TimeImport approval section (~5300–5800).
 */

import { Fragment, useId, useState, useTransition } from 'react';
import { Badge, ConfirmDangerModal, EmptyState, useToast } from '@/components/ui';
import { clientAlias } from '@/lib/clients';
import type { ApprovalUndoEntry } from '@/lib/time/approvalUndo';
import type { ContractorPeriodRow } from '@/lib/time/grouping';
import { editContractorTotal, setTimeApproval, undoApproval } from '@/server/actions/time';
import { AddHoursPanel } from './AddHoursPanel';
import { AddUnlistedRow } from './AddUnlistedRow';

interface ContractorOption {
  workerId: string;
  displayName: string;
  sourceName: string;
}

type ReviewRow = Pick<ContractorPeriodRow, 'sourceName' | 'approvalStatus'>;

/** A row still blocking payroll: nothing decided, or only some entries decided. */
const isRowPending = (row: ReviewRow): boolean =>
  row.approvalStatus === 'pending' || row.approvalStatus === 'mixed';

/**
 * What the grid shows: optionally only the rows that still block payroll, and
 * always pending-first so a partial pass leaves the remaining work on top
 * (RP-43). Ties break alphabetically, the previous — and only — order.
 */
export const reviewRows = <T extends ReviewRow>(rows: readonly T[], onlyPending: boolean): T[] =>
  (onlyPending ? rows.filter(isRowPending) : [...rows]).sort(
    (a, b) =>
      Number(isRowPending(b)) - Number(isRowPending(a)) || a.sourceName.localeCompare(b.sourceName),
  );

interface TimeApprovalTableProps {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  periodDays: number;
  workingDays: number;
  /** Cross-period "all unpaid" view: hide per-period coverage columns/summary. */
  coverageHidden?: boolean;
  rows: ContractorPeriodRow[];
  /** source_names that have no matching worker in the roster. */
  unmatchedNames: string[];
  contractorOptions: ContractorOption[];
  /** worker_id → assigned active CLIENT companies (the invoicing target). */
  assignedClients: Record<string, { id: string; name: string }[]>;
  /** worker_id → expected hours for this period (salaried only; absent = per-unit). */
  expectedByWorker?: Record<string, number>;
  onRefresh: () => void;
}

export const TimeApprovalTable = ({
  companyId,
  periodStart,
  periodEnd,
  periodDays,
  workingDays,
  coverageHidden = false,
  rows,
  unmatchedNames,
  contractorOptions,
  assignedClients,
  expectedByWorker = {},
  onRefresh,
}: TimeApprovalTableProps) => {
  const { notify, dismiss } = useToast();
  // busyKey (below), not the transition flag, drives disabling — a per-row scope.
  const [, startTransition] = useTransition();
  const [editMap, setEditMap] = useState<Record<string, string>>({});
  const [addRowName, setAddRowName] = useState<string | null>(null);
  const [onlyPending, setOnlyPending] = useState(false);
  const onlyPendingId = useId();
  // Which row (or '*' for the bulk buttons) is mid-write — so one row's action
  // no longer disables every button in the table (RP-43).
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Pending edit-total awaiting confirmation (RP-44).
  const [confirmEdit, setConfirmEdit] = useState<{
    row: ContractorPeriodRow;
    hours: number;
  } | null>(null);
  const bulkBusy = busyKey === '*';

  const pendingIds = rows
    .flatMap((r) => r.entries)
    .filter((e) => e.approval === 'pending')
    .map((e) => e.id);

  const visibleRows = reviewRows(rows, onlyPending);
  // The unpaid view drops the two coverage columns and Expected (period-scoped).
  const bodyColSpan = coverageHidden ? 7 : 10;

  const showUndoToast = (undoEntries: ApprovalUndoEntry[], label: string) => {
    if (undoEntries.length === 0) return;
    const toastId = notify(
      <span>
        {label}{' '}
        <button
          type="button"
          style={{
            fontWeight: 700,
            textDecoration: 'underline',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            color: 'inherit',
          }}
          onClick={() => {
            dismiss(toastId);
            startTransition(async () => {
              const res = await undoApproval({
                companyId,
                entries: undoEntries,
              });
              if (!res.ok) {
                notify(res.error, { type: 'error' });
                return;
              }
              notify('Approval undone.', { type: 'info' });
              if (res.data.calcNote) notify(res.data.calcNote, { type: 'warn' });
              onRefresh();
            });
          }}
        >
          Undo
        </button>
      </span>,
      { type: 'success', persistent: true },
    );
  };

  const handleApproval = (ids: string[], status: 'approved' | 'rejected', key = '*') => {
    setBusyKey(key);
    startTransition(async () => {
      try {
        const res = await setTimeApproval({ companyId, ids, status });
        if (!res.ok) {
          notify(res.error, { type: 'error' });
          return;
        }
        const verb = status === 'approved' ? 'Approved' : 'Rejected';
        const moved =
          res.data.moved > 0
            ? ` ${res.data.moved} contractor${res.data.moved === 1 ? '' : 's'} now on Calculate.`
            : '';
        const label = `${verb} ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}.${moved}`;
        showUndoToast(res.data.undoEntries, label);
        if (res.data.calcNote) notify(res.data.calcNote, { type: 'warn' });
        onRefresh();
      } finally {
        setBusyKey(null);
      }
    });
  };

  // Step 1: validate and ask. The write flattens the per-day breakdown and no
  // action can put it back, so it gets a confirm naming the damage (RP-44).
  const handleEditTotal = (row: ContractorPeriodRow) => {
    const val = editMap[row.sourceName];
    if (!val) return;
    const h = Number.parseFloat(val);
    if (Number.isNaN(h) || h < 0) {
      notify('Enter a valid number of hours.', { type: 'warn' });
      return;
    }
    setConfirmEdit({ row, hours: h });
  };

  // Step 2: the confirmed write.
  const runEditTotal = (row: ContractorPeriodRow, hours: number) => {
    const sortedIds = [...row.entries]
      .sort((a, b) => a.workDate.localeCompare(b.workDate))
      .map((e) => e.id);
    setBusyKey(row.sourceName);
    startTransition(async () => {
      try {
        const res = await editContractorTotal({
          companyId,
          sourceName: row.sourceName,
          ids: sortedIds,
          hours,
          periodStart,
          periodEnd,
        });
        if (!res.ok) {
          notify(res.error, { type: 'error' });
          return;
        }
        setConfirmEdit(null);
        setEditMap((prev) => {
          const next = { ...prev };
          delete next[row.sourceName];
          return next;
        });
        notify(`Updated total hours for ${row.sourceName}.`, { type: 'success' });
        onRefresh();
      } finally {
        setBusyKey(null);
      }
    });
  };

  return (
    <div>
      {/* Header actions */}
      <div className="card-head" style={{ marginBottom: 12 }}>
        <p className="sub" style={{ margin: 0 }}>
          {pendingIds.length} pending entr{pendingIds.length === 1 ? 'y' : 'ies'}
          {coverageHidden
            ? ' · spanning multiple periods (coverage and hour edits hidden — open a single period to edit)'
            : ` · ${periodDays} days in period · ${workingDays} working days`}
        </p>
        {rows.length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label
              htmlFor={onlyPendingId}
              className="sub"
              style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <input
                id={onlyPendingId}
                type="checkbox"
                checked={onlyPending}
                onChange={(e) => setOnlyPending(e.target.checked)}
              />
              Only pending
            </label>
            <button
              type="button"
              className="btn"
              disabled={busyKey !== null || pendingIds.length === 0}
              onClick={() => handleApproval(pendingIds, 'approved')}
            >
              {bulkBusy ? 'Working…' : `Approve all pending (${pendingIds.length})`}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busyKey !== null || pendingIds.length === 0}
              onClick={() => handleApproval(pendingIds, 'rejected')}
            >
              Reject all pending
            </button>
          </div>
        )}
      </div>

      {/* Unmatched names banner */}
      {unmatchedNames.length > 0 && (
        <div
          className="banner"
          style={{
            marginBottom: 10,
            background: 'var(--warn-soft)',
            borderColor: 'var(--warn)',
            color: 'var(--warn)',
          }}
        >
          <strong>
            {unmatchedNames.length} source name
            {unmatchedNames.length === 1 ? '' : 's'} not matched to a contractor
          </strong>{' '}
          — these rows will not be paid until matched. Set up their profile on the Contractors tab.
          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {unmatchedNames.map((n) => (
              <span key={n} className="pill warn">
                {n}
              </span>
            ))}
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState message="No time entries for this period. Import or add hours above." />
      ) : (
        <div className="table-scroll">
          <table aria-label="Tracked hours by contractor">
            <thead>
              <tr>
                <th scope="col">Contractor</th>
                {!coverageHidden && <th scope="col">Days in period</th>}
                {!coverageHidden && <th scope="col">Working days</th>}
                <th scope="col">Days worked</th>
                <th scope="col" title="Time clocked into Hubstaff timer">
                  Tracked (h)
                </th>
                <th scope="col" title="Paid time off (from Hubstaff API sync)">
                  PTO (h)
                </th>
                <th scope="col" title="Tracked + PTO — used by payroll">
                  Total (h)
                </th>
                {!coverageHidden && (
                  <th
                    scope="col"
                    title="Working days × contracted day-hours (8 FT / 4 PT). Per-unit contractors have none."
                  >
                    Expected (h)
                  </th>
                )}
                <th scope="col">Status</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={bodyColSpan} className="sub">
                    Nothing pending — untick “Only pending” to see the {rows.length} decided row
                    {rows.length === 1 ? '' : 's'}.
                  </td>
                </tr>
              )}
              {visibleRows.map((row) => {
                // In the cross-period view a row aggregates entries from
                // several periods, and both writes below are period-scoped —
                // edit-total rewrites the whole total onto the earliest entry,
                // Add hours targets the picked period. Approve/reject are
                // per-entry and stay available.
                const isEditing = !coverageHidden && editMap[row.sourceName] !== undefined;
                const isAdding = !coverageHidden && addRowName === row.sourceName;
                const rowBusy = bulkBusy || busyKey === row.sourceName;
                const allIds = row.entries.map((e) => e.id);
                const trackedH = (row.trackedSeconds / 3600).toFixed(2);
                const ptoH = (row.ptoSeconds / 3600).toFixed(2);
                const totalH = (row.totalSeconds / 3600).toFixed(2);

                const statusTone =
                  row.approvalStatus === 'approved'
                    ? 'good'
                    : row.approvalStatus === 'rejected'
                      ? 'bad'
                      : 'warn';

                return (
                  <Fragment key={row.sourceName}>
                    <tr>
                      <td className="card-title">
                        <b>{row.sourceName}</b>
                        {(() => {
                          const clients = row.workerId ? (assignedClients[row.workerId] ?? []) : [];
                          if (clients.length === 1) {
                            return (
                              <div className="muted" style={{ fontSize: 11 }}>
                                → {clientAlias(clients[0]?.name)}
                              </div>
                            );
                          }
                          return (
                            <div style={{ fontSize: 11, color: 'var(--warn)' }}>
                              ⚠{' '}
                              {clients.length === 0
                                ? 'no client assigned'
                                : `${clients.length} clients`}
                            </div>
                          );
                        })()}
                      </td>
                      {!coverageHidden && <td data-label="Days in period">{periodDays}</td>}
                      {!coverageHidden && <td data-label="Working days">{workingDays}</td>}
                      <td data-label="Days worked">{row.daysWorked}</td>

                      {/* Tracked — editable (manual edit-total override). */}
                      <td data-label="Tracked (h)">
                        {isEditing ? (
                          <span
                            style={{
                              display: 'inline-flex',
                              gap: 4,
                              alignItems: 'center',
                            }}
                          >
                            <input
                              type="number"
                              step="0.01"
                              style={{ width: 80 }}
                              aria-label={`Tracked hours for ${row.sourceName}`}
                              value={editMap[row.sourceName] ?? ''}
                              onChange={(e) =>
                                setEditMap((prev) => ({
                                  ...prev,
                                  [row.sourceName]: e.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              className="btn sm"
                              aria-label={`Save tracked hours for ${row.sourceName}`}
                              disabled={rowBusy}
                              onClick={() => handleEditTotal(row)}
                            >
                              <span aria-hidden="true">✓</span>
                            </button>
                            <button
                              type="button"
                              className="btn ghost sm"
                              aria-label="Cancel edit"
                              onClick={() =>
                                setEditMap((prev) => {
                                  const next = { ...prev };
                                  delete next[row.sourceName];
                                  return next;
                                })
                              }
                            >
                              <span aria-hidden="true">✕</span>
                            </button>
                          </span>
                        ) : (
                          <span>
                            {trackedH}
                            {!coverageHidden && (
                              <button
                                type="button"
                                className="btn ghost sm"
                                title="Edit tracked hours"
                                aria-label={`Edit tracked hours for ${row.sourceName}`}
                                style={{ padding: '1px 6px', marginLeft: 4 }}
                                onClick={() =>
                                  setEditMap((prev) => ({
                                    ...prev,
                                    [row.sourceName]: trackedH,
                                  }))
                                }
                              >
                                ✎
                              </button>
                            )}
                          </span>
                        )}
                      </td>

                      {/* PTO — API-sourced, not editable here. */}
                      <td
                        data-label="PTO (h)"
                        style={
                          row.ptoSeconds > 0
                            ? { color: 'var(--accent)', fontWeight: 600 }
                            : { color: 'var(--muted)' }
                        }
                      >
                        {row.ptoSeconds > 0 ? ptoH : '—'}
                      </td>

                      <td data-label="Total (h)" style={{ fontWeight: 600 }}>
                        {totalH}
                      </td>

                      {/* Expected — salaried contracts only; per-unit have none. */}
                      {!coverageHidden && (
                        <td data-label="Expected (h)" style={{ color: 'var(--muted)' }}>
                          {row.workerId && expectedByWorker[row.workerId] != null
                            ? expectedByWorker[row.workerId]?.toFixed(2)
                            : '—'}
                        </td>
                      )}

                      <td data-label="Status">
                        <Badge tone={statusTone}>{row.approvalStatus}</Badge>
                      </td>

                      <td
                        className="card-action"
                        style={{ textAlign: 'right', whiteSpace: 'nowrap' }}
                      >
                        <button
                          type="button"
                          className="btn sm"
                          disabled={rowBusy}
                          onClick={() => handleApproval(allIds, 'approved', row.sourceName)}
                        >
                          {rowBusy ? 'Working…' : 'Approve'}
                        </button>{' '}
                        {!coverageHidden && (
                          <>
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={rowBusy}
                              onClick={() => {
                                if (isAdding) {
                                  setAddRowName(null);
                                  return;
                                }
                                setAddRowName(row.sourceName);
                              }}
                            >
                              {isAdding ? 'Close' : 'Add hours'}
                            </button>{' '}
                          </>
                        )}
                        <button
                          type="button"
                          className="btn ghost sm"
                          style={{
                            borderColor: 'var(--bad)',
                            color: 'var(--bad)',
                          }}
                          disabled={rowBusy}
                          onClick={() => handleApproval(allIds, 'rejected', row.sourceName)}
                          title="Reject this contractor's time for the period"
                        >
                          Reject
                        </button>
                      </td>
                    </tr>

                    {/* Expansion row for the per-contractor Add Hours panel. */}
                    {isAdding && (
                      <tr style={{ background: '#f8fafc' }}>
                        <td colSpan={bodyColSpan}>
                          <AddHoursPanel
                            companyId={companyId}
                            workerId={row.workerId}
                            sourceName={row.sourceName}
                            periodStart={periodStart}
                            periodEnd={periodEnd}
                            onDone={() => {
                              setAddRowName(null);
                              onRefresh();
                            }}
                            onCancel={() => setAddRowName(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}

              <AddUnlistedRow
                companyId={companyId}
                contractorOptions={contractorOptions}
                defaultPeriodStart={periodStart}
                defaultPeriodEnd={periodEnd}
                colSpan={bodyColSpan}
                onDone={onRefresh}
              />
            </tbody>
          </table>
        </div>
      )}

      {confirmEdit && (
        <ConfirmDangerModal
          title={`Replace ${confirmEdit.row.sourceName}'s hours?`}
          message={`Sets the period total to ${confirmEdit.hours}h — it replaces the daily breakdown (${confirmEdit.row.entries.length} day${confirmEdit.row.entries.length === 1 ? '' : 's'}) with a single first-day entry and zeroes the other days.`}
          consequence="The per-day split can't be restored afterwards — there is no undo for this edit."
          confirmLabel="Replace breakdown"
          busy={busyKey === confirmEdit.row.sourceName}
          onConfirm={() => runEditTotal(confirmEdit.row, confirmEdit.hours)}
          onCancel={() => setConfirmEdit(null)}
        />
      )}
    </div>
  );
};
