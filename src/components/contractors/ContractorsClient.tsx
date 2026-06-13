'use client';

import type { SortableColumn } from '@/components/ui';
import { Badge, ConfirmDangerModal, EmptyState, SortableTable, useToast } from '@/components/ui';
import type { RosterWorker } from '@/db/queries/workers';
import { centavosToPhp, fmtDate, money } from '@/lib/format';
import type { RateRow } from '@/lib/pay/rates';
import { resolveRate } from '@/lib/pay/rates';
import { setContractorLinkStatus } from '@/server/actions/contractors';
import { useState, useTransition } from 'react';
import { AddContractorModal } from './AddContractorModal';
import { ProfilePanel } from './ProfilePanel';

type Props = {
  companyId: string;
  roster: RosterWorker[];
  allRates: RateRow[];
  today: string;
};

type RowShape = RosterWorker & {
  _name: string;
  _currentRateCentavos: number | null;
  _statusLabel: 'active' | 'inactive';
};

function fullName(w: RosterWorker): string {
  return [w.firstName, w.middleName, w.lastName].filter(Boolean).join(' ').trim();
}

export function ContractorsClient({ companyId, roster, allRates, today }: Props) {
  const { notify } = useToast();

  // Derive period edges from today (semi-monthly: 1–15 or 16–end).
  const todayParts = today.split('-').map(Number);
  const yyyy = todayParts[0] ?? new Date().getFullYear();
  const mm = todayParts[1] ?? 1;
  const dd = todayParts[2] ?? 1;
  const day = dd;
  const mmStr = String(mm).padStart(2, '0');
  const periodStart = day <= 15 ? `${yyyy}-${mmStr}-01` : `${yyyy}-${mmStr}-16`;
  const periodEnd =
    day <= 15
      ? `${yyyy}-${mmStr}-15`
      : (() => {
          const last = new Date(yyyy, mm, 0).getDate();
          return `${yyyy}-${mmStr}-${String(last).padStart(2, '0')}`;
        })();

  const [rows, setRows] = useState<RowShape[]>(() =>
    buildRows(roster, allRates, periodStart, periodEnd),
  );
  const [showInactive, setShowInactive] = useState(false);
  const [selectedWorker, setSelectedWorker] = useState<RosterWorker | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState<RosterWorker | null>(null);
  const [reactivateTarget, setReactivateTarget] = useState<RosterWorker | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();

  const visibleRows = showInactive ? rows : rows.filter((r) => r._statusLabel === 'active');
  const inactiveCount = rows.filter((r) => r._statusLabel !== 'active').length;

  function refreshRow(updated: RosterWorker) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.workerId !== updated.workerId) return r;
        const shaped: RowShape = {
          ...updated,
          _name: fullName(updated),
          _currentRateCentavos: resolveRate(allRates, updated.workerId, periodStart, periodEnd),
          _statusLabel: isActive(updated) ? 'active' : 'inactive',
        };
        return shaped;
      }),
    );
  }

  function appendRow(worker: RosterWorker) {
    const shaped: RowShape = {
      ...worker,
      _name: fullName(worker),
      _currentRateCentavos: resolveRate(allRates, worker.workerId, periodStart, periodEnd),
      _statusLabel: isActive(worker) ? 'active' : 'inactive',
    };
    setRows((prev) => [shaped, ...prev]);
  }

  function handleDeactivate(worker: RosterWorker) {
    setDeactivateTarget(worker);
  }

  function handleReactivate(worker: RosterWorker) {
    setReactivateTarget(worker);
  }

  function toggleStatus(worker: RosterWorker, active: boolean) {
    const id = worker.workerId;
    setBusyIds((s) => new Set([...s, id]));
    startTransition(async () => {
      const result = await setContractorLinkStatus({ workerId: id, companyId, active });
      setBusyIds((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      if (!result.ok) {
        notify(result.error, { type: 'error' });
        return;
      }
      notify(active ? 'Contractor reactivated.' : 'Contractor deactivated.', {
        type: 'success',
      });
      const newStatus = active ? 'active' : 'ended';
      const updated: RosterWorker = {
        ...worker,
        workerStatus: newStatus as RosterWorker['workerStatus'],
        linkStatus: newStatus as RosterWorker['linkStatus'],
      };
      refreshRow(updated);
      if (selectedWorker?.workerId === id) setSelectedWorker(updated);
    });
  }

  const columns: ReadonlyArray<SortableColumn<RowShape>> = [
    {
      key: '_name',
      label: 'Name',
      sortable: true,
      cardTitle: true,
      accessor: (r) => r._name,
      render: (r) => (
        <button
          type="button"
          className="btn ghost sm"
          style={{ textAlign: 'left', fontWeight: 600 }}
          onClick={() => setSelectedWorker(r)}
        >
          {r._name || '(no name)'}
        </button>
      ),
    },
    {
      key: 'role',
      label: 'Role',
      sortable: true,
      accessor: (r) => r.role ?? '',
      render: (r) => r.role ?? <span className="muted">—</span>,
    },
    {
      key: 'contract',
      label: 'Contract',
      sortable: true,
      accessor: (r) => r.contract,
      render: (r) => <Badge tone={r.contract === 'FT' ? 'good' : 'neutral'}>{r.contract}</Badge>,
    },
    {
      key: '_statusLabel',
      label: 'Status',
      sortable: true,
      accessor: (r) => r._statusLabel,
      render: (r) => (
        <Badge tone={r._statusLabel === 'active' ? 'good' : 'neutral'}>{r._statusLabel}</Badge>
      ),
    },
    {
      key: '_currentRateCentavos',
      label: 'Current rate',
      sortable: true,
      accessor: (r) => r._currentRateCentavos ?? -1,
      render: (r) =>
        r._currentRateCentavos != null ? (
          money(centavosToPhp(r._currentRateCentavos))
        ) : (
          <span className="muted">not set</span>
        ),
    },
    {
      key: 'hireDate',
      label: 'Hire date',
      sortable: true,
      accessor: (r) => r.hireDate ?? '',
      render: (r) => fmtDate(r.hireDate),
    },
    {
      key: 'payoutMethod',
      label: 'Payout',
      sortable: true,
      accessor: (r) => r.payoutMethod ?? '',
      render: (r) => (r.payoutMethod ? r.payoutMethod : <Badge tone="warn">not set</Badge>),
    },
    {
      key: 'hubstaffName',
      label: 'Hubstaff',
      sortable: true,
      accessor: (r) => r.hubstaffName ?? '',
      render: (r) => r.hubstaffName ?? <span className="muted">—</span>,
    },
    {
      key: '_actions',
      label: '',
      sortable: false,
      render: (r) => (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost sm" onClick={() => setSelectedWorker(r)}>
            Edit
          </button>
          {r._statusLabel === 'active' ? (
            <button
              type="button"
              className="btn ghost sm"
              disabled={busyIds.has(r.workerId)}
              onClick={() => handleDeactivate(r)}
            >
              Deactivate
            </button>
          ) : (
            <button
              type="button"
              className="btn sm"
              disabled={busyIds.has(r.workerId)}
              onClick={() => handleReactivate(r)}
            >
              Reactivate
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="card" style={{ marginBottom: 0 }}>
        <div className="actionbar">
          <div>
            <h2 style={{ margin: 0 }}>Contractors</h2>
            <p className="sub" style={{ margin: '4px 0 0' }}>
              {visibleRows.length} shown
              {inactiveCount > 0 ? ` · ${inactiveCount} inactive` : ''} · Click a name or Edit for
              the full profile.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              Show inactive
            </label>
            <button type="button" className="btn" onClick={() => setShowAdd(true)}>
              + Add contractor
            </button>
          </div>
        </div>

        {visibleRows.length === 0 && !isPending ? (
          <EmptyState
            icon="👥"
            message="No contractors yet."
            action={
              <button type="button" className="btn" onClick={() => setShowAdd(true)}>
                Add your first contractor
              </button>
            }
          />
        ) : (
          <SortableTable
            columns={columns}
            rows={visibleRows}
            rowKey={(r) => r.workerId}
            filterPlaceholder="Filter by name, role, hubstaff…"
            onRowClick={(r) => setSelectedWorker(r)}
          />
        )}
      </div>

      {selectedWorker && (
        <ProfilePanel
          worker={selectedWorker}
          companyId={companyId}
          onClose={() => setSelectedWorker(null)}
          onSaved={(updated) => {
            refreshRow(updated);
            setSelectedWorker(updated);
            notify('Saved.', { type: 'success' });
          }}
        />
      )}

      {showAdd && (
        <AddContractorModal
          companyId={companyId}
          onClose={() => setShowAdd(false)}
          onCreated={(worker) => {
            appendRow(worker);
            setShowAdd(false);
            setSelectedWorker(worker);
            notify('Contractor created — fill in their profile below.', { type: 'success' });
          }}
        />
      )}

      {deactivateTarget && (
        <ConfirmDangerModal
          title="Deactivate contractor"
          message={`Deactivate ${fullName(deactivateTarget)}? They will be excluded from payroll calculations.`}
          consequence="You can reactivate them at any time."
          confirmLabel="Deactivate"
          busy={busyIds.has(deactivateTarget.workerId)}
          onConfirm={() => {
            const target = deactivateTarget;
            setDeactivateTarget(null);
            toggleStatus(target, false);
          }}
          onCancel={() => setDeactivateTarget(null)}
        />
      )}

      {reactivateTarget && (
        <ConfirmDangerModal
          title="Reactivate contractor"
          message={`Reactivate ${fullName(reactivateTarget)}? They will be included in payroll calculations again.`}
          confirmLabel="Reactivate"
          busy={busyIds.has(reactivateTarget.workerId)}
          onConfirm={() => {
            const target = reactivateTarget;
            setReactivateTarget(null);
            toggleStatus(target, true);
          }}
          onCancel={() => setReactivateTarget(null)}
        />
      )}
    </>
  );
}

function isActive(w: RosterWorker): boolean {
  return w.workerStatus === 'active' && w.linkStatus === 'active';
}

function buildRows(
  roster: RosterWorker[],
  allRates: RateRow[],
  periodStart: string,
  periodEnd: string,
): RowShape[] {
  return roster.map((w) => ({
    ...w,
    _name: [w.firstName, w.middleName, w.lastName].filter(Boolean).join(' ').trim(),
    _currentRateCentavos: resolveRate(allRates, w.workerId, periodStart, periodEnd),
    _statusLabel: isActive(w) ? ('active' as const) : ('inactive' as const),
  }));
}
