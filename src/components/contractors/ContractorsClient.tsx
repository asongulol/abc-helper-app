'use client';

import { AnnouncementsCard } from '@/components/config/AnnouncementsCard';
import type { SortableColumn } from '@/components/ui';
import {
  Badge,
  ConfirmDangerModal,
  EmptyState,
  Modal,
  SortableTable,
  useToast,
} from '@/components/ui';
import type { AnnouncementRow } from '@/db/queries/config';
import type { RosterWorker } from '@/db/queries/workers';
import type { RateRow } from '@/lib/pay/rates';
import { setContractorLinkStatus } from '@/server/actions/contractors';
import { deleteContractor } from '@/server/actions/portal-admin';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { AddContractorWizard } from './AddContractorWizard';
import { BulkImportModal } from './BulkImportModal';
import { ProfilePanel } from './ProfilePanel';
import { PullWiseRecipientsModal } from './PullWiseRecipientsModal';

type Props = {
  companyId: string;
  roster: RosterWorker[];
  allRates: RateRow[];
  today: string;
  isOwner: boolean;
  countersigners: { userId: string; name: string }[];
  clientsByWorker: Record<string, string[]>;
  companies: { id: string; name: string }[];
  announcements: AnnouncementRow[];
};

type RowShape = RosterWorker & {
  _name: string;
  _statusLabel: 'active' | 'inactive';
};

function fullName(w: RosterWorker): string {
  return [w.firstName, w.middleName, w.lastName].filter(Boolean).join(' ').trim();
}

export function ContractorsClient({
  companyId,
  roster,
  isOwner,
  countersigners,
  clientsByWorker,
  companies,
  announcements,
}: Props) {
  const { notify } = useToast();
  const router = useRouter();

  const [rows, setRows] = useState<RowShape[]>(() => buildRows(roster));
  const [showInactive, setShowInactive] = useState(false);
  const [selectedWorker, setSelectedWorker] = useState<RosterWorker | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [showPullWise, setShowPullWise] = useState(false);
  const [showAnnounce, setShowAnnounce] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState<RosterWorker | null>(null);
  const [reactivateTarget, setReactivateTarget] = useState<RosterWorker | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RosterWorker | null>(null);
  const [deleting, setDeleting] = useState(false);
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
          _statusLabel: isActive(updated) ? 'active' : 'inactive',
        };
        return shaped;
      }),
    );
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
      key: 'clients',
      label: 'Client',
      sortable: false,
      render: (r) => {
        const names = clientsByWorker[r.workerId];
        return names && names.length > 0 ? names.join(', ') : <span className="muted">—</span>;
      },
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
      key: 'payoutMethod',
      label: 'Payout',
      sortable: true,
      accessor: (r) => r.payoutMethod ?? '',
      render: (r) => (r.payoutMethod ? r.payoutMethod : <Badge tone="warn">not set</Badge>),
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
          {isOwner && r._statusLabel !== 'active' && (
            <button type="button" className="btn ghost sm" onClick={() => setDeleteTarget(r)}>
              Delete
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
              Current company · {visibleRows.length} shown
              {inactiveCount > 0 ? ` · ${inactiveCount} inactive` : ''}. Click a row (or Edit) for
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
            <button type="button" className="btn ghost" onClick={() => setShowPullWise(true)}>
              ⤓ Pull IDs from Wise
            </button>
            <button type="button" className="btn ghost" onClick={() => setShowBulk(true)}>
              ⇪ Bulk import
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setShowAnnounce(true)}
              title="Post announcements to the contractor portal welcome page"
            >
              📣 Announcements
            </button>
            <button type="button" className="btn" onClick={() => setShowAdd(true)}>
              + Add contractor
            </button>
          </div>
        </div>

        {visibleRows.length === 0 && !isPending ? (
          <EmptyState
            icon="👥"
            message="No contractors match."
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
            filterPlaceholder="Filter by name, client, role…"
            onRowClick={(r) => setSelectedWorker(r)}
          />
        )}
      </div>

      {selectedWorker && (
        <ProfilePanel
          worker={selectedWorker}
          companyId={companyId}
          companies={companies}
          onClose={() => setSelectedWorker(null)}
          onSaved={(updated) => {
            refreshRow(updated);
            setSelectedWorker(updated);
            notify('Saved.', { type: 'success' });
          }}
        />
      )}

      {showAdd && (
        <AddContractorWizard
          companyId={companyId}
          companyName={companies.find((c) => c.id === companyId)?.name ?? ''}
          countersigners={countersigners}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            router.refresh();
          }}
        />
      )}

      {showBulk && <BulkImportModal companyId={companyId} onClose={() => setShowBulk(false)} />}

      {showPullWise && <PullWiseRecipientsModal onClose={() => setShowPullWise(false)} />}

      {showAnnounce && (
        <Modal onClose={() => setShowAnnounce(false)} maxWidth={640}>
          <AnnouncementsCard announcements={announcements} />
        </Modal>
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

      {deleteTarget && (
        <ConfirmDangerModal
          title="Delete contractor permanently"
          message={`Permanently delete ${fullName(deleteTarget)}? This removes their portal login, rates, onboarding, and uploaded documents.`}
          consequence="Cannot be undone. Blocked if they have any payroll or time history — deactivate instead."
          confirmWord={fullName(deleteTarget) || 'DELETE'}
          confirmLabel="Delete forever"
          busy={deleting}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleting(true);
            startTransition(async () => {
              const res = await deleteContractor({ workerId: target.workerId, force: true });
              setDeleting(false);
              setDeleteTarget(null);
              if (!res.ok) {
                notify(res.error, { type: 'error' });
                return;
              }
              notify('Contractor deleted.', { type: 'success' });
              router.refresh();
            });
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}

function isActive(w: RosterWorker): boolean {
  return w.workerStatus === 'active' && w.linkStatus === 'active';
}

function buildRows(roster: RosterWorker[]): RowShape[] {
  return roster.map((w) => ({
    ...w,
    _name: [w.firstName, w.middleName, w.lastName].filter(Boolean).join(' ').trim(),
    _statusLabel: isActive(w) ? ('active' as const) : ('inactive' as const),
  }));
}
