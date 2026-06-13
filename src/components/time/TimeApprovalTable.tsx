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

import { Badge, EmptyState, useToast } from '@/components/ui';
import type { ContractorPeriodRow } from '@/lib/time/grouping';
import type { ApprovalUndoEntry } from '@/server/actions/time';
import { editContractorTotal, setTimeApproval, undoApproval } from '@/server/actions/time';
import { Fragment, useState, useTransition } from 'react';
import { AddHoursPanel } from './AddHoursPanel';
import { AddUnlistedRow } from './AddUnlistedRow';

interface ContractorOption {
  workerId: string;
  displayName: string;
  sourceName: string;
}

interface TimeApprovalTableProps {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  periodDays: number;
  workingDays: number;
  rows: ContractorPeriodRow[];
  /** source_names that have no matching worker in the roster. */
  unmatchedNames: string[];
  contractorOptions: ContractorOption[];
  onRefresh: () => void;
}

export const TimeApprovalTable = ({
  companyId,
  periodStart,
  periodEnd,
  periodDays,
  workingDays,
  rows,
  unmatchedNames,
  contractorOptions,
  onRefresh,
}: TimeApprovalTableProps) => {
  const { notify, dismiss } = useToast();
  const [pendingTx, startTransition] = useTransition();
  const [editMap, setEditMap] = useState<Record<string, string>>({});
  const [addRowName, setAddRowName] = useState<string | null>(null);

  const pendingIds = rows
    .flatMap((r) => r.entries)
    .filter((e) => e.approval === 'pending')
    .map((e) => e.id);

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
              const res = await undoApproval({ companyId, entries: undoEntries });
              if (!res.ok) {
                notify(res.error, { type: 'error' });
                return;
              }
              notify('Approval undone.', { type: 'info' });
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

  const handleApproval = (ids: string[], status: 'approved' | 'rejected') => {
    startTransition(async () => {
      const res = await setTimeApproval({ companyId, ids, status });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      const verb = status === 'approved' ? 'Approved' : 'Rejected';
      const label = `${verb} ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}.`;
      showUndoToast(res.data.undoEntries, label);
      onRefresh();
    });
  };

  const handleEditTotal = (row: ContractorPeriodRow) => {
    const val = editMap[row.sourceName];
    if (!val) return;
    const h = Number.parseFloat(val);
    if (Number.isNaN(h) || h < 0) {
      notify('Enter a valid number of hours.', { type: 'warn' });
      return;
    }
    const sortedIds = [...row.entries]
      .sort((a, b) => a.workDate.localeCompare(b.workDate))
      .map((e) => e.id);
    startTransition(async () => {
      const res = await editContractorTotal({
        companyId,
        sourceName: row.sourceName,
        ids: sortedIds,
        hours: h,
        periodStart,
        periodEnd,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      setEditMap((prev) => {
        const next = { ...prev };
        delete next[row.sourceName];
        return next;
      });
      notify(`Updated total hours for ${row.sourceName}.`, { type: 'success' });
      onRefresh();
    });
  };

  return (
    <div>
      {/* Header actions */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 12,
        }}
      >
        <p className="sub" style={{ margin: 0 }}>
          {pendingIds.length} pending entr{pendingIds.length === 1 ? 'y' : 'ies'} · {periodDays}{' '}
          days in period · {workingDays} working days
        </p>
        {rows.length > 0 && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={pendingTx || pendingIds.length === 0}
              onClick={() => handleApproval(pendingIds, 'approved')}
            >
              {pendingTx ? 'Working…' : `Approve all pending (${pendingIds.length})`}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={pendingTx || pendingIds.length === 0}
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
            borderColor: '#fcd34d',
            color: '#92400e',
          }}
        >
          <strong>
            {unmatchedNames.length} source name{unmatchedNames.length === 1 ? '' : 's'} not matched
            to a contractor
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
          <table>
            <thead>
              <tr>
                <th>Contractor</th>
                <th>Days in period</th>
                <th>Working days</th>
                <th>Days worked</th>
                <th title="Time clocked into Hubstaff timer">Tracked (h)</th>
                <th title="Paid time off (from Hubstaff API sync)">PTO (h)</th>
                <th title="Tracked + PTO — used by payroll">Total (h)</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isEditing = editMap[row.sourceName] !== undefined;
                const isAdding = addRowName === row.sourceName;
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
                      </td>
                      <td data-label="Days in period">{periodDays}</td>
                      <td data-label="Working days">{workingDays}</td>
                      <td data-label="Days worked">{row.daysWorked}</td>

                      {/* Tracked — editable (manual edit-total override). */}
                      <td data-label="Tracked (h)">
                        {isEditing ? (
                          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <input
                              type="number"
                              step="0.01"
                              style={{ width: 80 }}
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
                              disabled={pendingTx}
                              onClick={() => handleEditTotal(row)}
                            >
                              ✓
                            </button>
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={() =>
                                setEditMap((prev) => {
                                  const next = { ...prev };
                                  delete next[row.sourceName];
                                  return next;
                                })
                              }
                            >
                              ✕
                            </button>
                          </span>
                        ) : (
                          <span>
                            {trackedH}
                            <button
                              type="button"
                              className="btn ghost sm"
                              title="Edit tracked hours"
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
                          disabled={pendingTx}
                          onClick={() => handleApproval(allIds, 'approved')}
                        >
                          Approve
                        </button>{' '}
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={pendingTx}
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
                        <button
                          type="button"
                          className="btn ghost sm"
                          style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
                          disabled={pendingTx}
                          onClick={() => handleApproval(allIds, 'rejected')}
                          title="Reject this contractor's time for the period"
                        >
                          Reject
                        </button>
                      </td>
                    </tr>

                    {/* Expansion row for the per-contractor Add Hours panel. */}
                    {isAdding && (
                      <tr style={{ background: '#f8fafc' }}>
                        <td colSpan={9}>
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
                onDone={onRefresh}
              />
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
