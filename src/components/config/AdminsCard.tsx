'use client';

import { Badge } from '@/components/ui';
import { ConfirmDangerModal } from '@/components/ui';
import { EmptyState } from '@/components/ui';
import { SortableTable } from '@/components/ui';
import { useToast } from '@/components/ui';
import type { SortableColumn } from '@/components/ui';
import type { AdminRow } from '@/db/queries/admins';
import { fmtDate } from '@/lib/format';
import { addAdmin, removeAdmin, setAdminRole } from '@/server/actions/admin-manage';
import { useId, useState, useTransition } from 'react';

interface AdminsCardProps {
  admins: AdminRow[];
  /** All visible company IDs (for scope selection). */
  companyOptions: ReadonlyArray<{ id: string; name: string }>;
  /** Whether the current viewer is an owner (gated UI). */
  isOwner: boolean;
}

interface AddFormState {
  email: string;
  name: string;
  role: string;
}

/**
 * Admins management card — owner-only. Lists admin_users + company scope,
 * supports add / remove / set-role via admin-manage actions.
 * The actions may throw (stub bodies); errors are caught and toasted.
 */
export const AdminsCard = ({ admins, companyOptions, isOwner }: AdminsCardProps) => {
  const toast = useToast();
  const formEmailId = useId();
  const formNameId = useId();
  const formRoleId = useId();

  const [, startTransition] = useTransition();
  const [removeTarget, setRemoveTarget] = useState<AdminRow | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const [addForm, setAddForm] = useState<AddFormState>({ email: '', name: '', role: 'admin' });
  const [addBusy, setAddBusy] = useState(false);

  const handleAdd = () => {
    if (!addForm.email.trim()) {
      toast.notify('Email is required.', { type: 'error' });
      return;
    }
    setAddBusy(true);
    startTransition(async () => {
      try {
        const res = await addAdmin({
          email: addForm.email.trim(),
          ...(addForm.name.trim() ? { name: addForm.name.trim() } : {}),
          role: addForm.role,
          companyIds: [],
        });
        if (res.ok) {
          toast.notify('Admin added.', { type: 'success' });
          setAddForm({ email: '', name: '', role: 'admin' });
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to add admin.', { type: 'error' });
      } finally {
        setAddBusy(false);
      }
    });
  };

  const handleRemoveConfirm = () => {
    if (!removeTarget) return;
    setRemoveBusy(true);
    startTransition(async () => {
      try {
        const res = await removeAdmin({ email: removeTarget.email });
        if (res.ok) {
          toast.notify(`${removeTarget.email} removed.`, { type: 'success' });
          setRemoveTarget(null);
        } else {
          toast.notify(res.error, { type: 'error' });
          setRemoveBusy(false);
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to remove admin.', { type: 'error' });
        setRemoveBusy(false);
      }
    });
  };

  const handleRoleToggle = (admin: AdminRow, newRole: string) => {
    startTransition(async () => {
      try {
        const res = await setAdminRole({ email: admin.email, role: newRole });
        if (res.ok) {
          toast.notify(`Role updated to "${newRole}".`, { type: 'success' });
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to update role.', { type: 'error' });
      }
    });
  };

  const columns: ReadonlyArray<SortableColumn<AdminRow>> = [
    {
      key: 'email',
      label: 'Email',
      sortable: true,
      cardTitle: true,
      accessor: (r) => r.email,
    },
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      accessor: (r) => r.name ?? '',
      render: (r) => r.name ?? <span className="muted">—</span>,
    },
    {
      key: 'role',
      label: 'Role',
      sortable: true,
      accessor: (r) => r.role,
      render: (r) => <Badge tone={r.role === 'owner' ? 'good' : 'neutral'}>{r.role}</Badge>,
    },
    {
      key: 'scope',
      label: 'Company scope',
      sortable: false,
      render: (r) => {
        if (r.role === 'owner') return <span className="muted">All companies</span>;
        if (r.companyIds.length === 0) return <span className="muted">None</span>;
        const names = r.companyIds.map((id) => {
          const found = companyOptions.find((c) => c.id === id);
          return found?.name ?? id;
        });
        return <span>{names.join(', ')}</span>;
      },
    },
    {
      key: 'addedAt',
      label: 'Added',
      sortable: true,
      accessor: (r) => r.addedAt,
      render: (r) => fmtDate(r.addedAt),
    },
    ...(isOwner
      ? [
          {
            key: 'actions',
            label: 'Actions',
            sortable: false,
            render: (r: AdminRow) => {
              if (r.role === 'owner') return null;
              return (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => handleRoleToggle(r, r.role === 'admin' ? 'viewer' : 'admin')}
                    title={`Switch to ${r.role === 'admin' ? 'viewer' : 'admin'}`}
                  >
                    {r.role === 'admin' ? '→ Viewer' : '→ Admin'}
                  </button>
                  <button
                    type="button"
                    className="btn danger-outline sm"
                    onClick={() => setRemoveTarget(r)}
                  >
                    Remove
                  </button>
                </div>
              );
            },
          } satisfies SortableColumn<AdminRow>,
        ]
      : []),
  ];

  return (
    <div className="card">
      <h3>Admin users</h3>
      <p className="sub">
        {isOwner
          ? 'Owner-only: manage who can access this admin app.'
          : 'Read-only view of admin users.'}
      </p>

      {admins.length === 0 ? (
        <EmptyState icon="👤" message="No admin users found." />
      ) : (
        <SortableTable
          columns={columns}
          rows={admins}
          rowKey={(r) => r.userId}
          filterable={admins.length > 5}
          filterPlaceholder="Filter admins…"
        />
      )}

      {isOwner && (
        <div className="actionbar" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <strong style={{ marginBottom: 8 }}>Add admin</strong>
          <div className="row">
            <div className="field" style={{ minWidth: 220 }}>
              <label htmlFor={formEmailId}>Email</label>
              <input
                id={formEmailId}
                type="email"
                value={addForm.email}
                onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="admin@example.com"
                disabled={addBusy}
              />
            </div>
            <div className="field" style={{ minWidth: 160 }}>
              <label htmlFor={formNameId}>Name (optional)</label>
              <input
                id={formNameId}
                type="text"
                value={addForm.name}
                onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Full name"
                disabled={addBusy}
              />
            </div>
            <div className="field" style={{ minWidth: 130 }}>
              <label htmlFor={formRoleId}>Role</label>
              <select
                id={formRoleId}
                value={addForm.role}
                onChange={(e) => setAddForm((f) => ({ ...f, role: e.target.value }))}
                disabled={addBusy}
              >
                <option value="admin">admin</option>
                <option value="viewer">viewer</option>
              </select>
            </div>
          </div>
          <button
            type="button"
            className="btn"
            onClick={handleAdd}
            disabled={addBusy || !addForm.email.trim()}
          >
            {addBusy ? 'Adding…' : 'Add admin'}
          </button>
        </div>
      )}

      {removeTarget != null && (
        <ConfirmDangerModal
          title="Remove admin"
          message={`Remove ${removeTarget.email} from this admin app?`}
          consequence="They will immediately lose access. This cannot be undone."
          confirmWord="REMOVE"
          confirmLabel="Remove"
          busy={removeBusy}
          onConfirm={handleRemoveConfirm}
          onCancel={() => {
            setRemoveTarget(null);
            setRemoveBusy(false);
          }}
        />
      )}
    </div>
  );
};
