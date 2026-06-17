'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { ContactsEditor } from '@/components/config/ContactsEditor';
import type { SortableColumn } from '@/components/ui';
import {
  Badge,
  ConfirmDangerModal,
  EmptyState,
  PhoneInput,
  SortableTable,
  useToast,
} from '@/components/ui';
import type { CompanyContact, CompanyFullRow } from '@/db/queries/config';
import { deleteClient, saveClient, setClientStatus } from '@/server/actions/config';

interface ClientsCardProps {
  clients: CompanyFullRow[];
  /**
   * Whether the current viewer is an owner. Retained for wiring; the Delete
   * button is shown for all admins and the server action enforces owner.
   */
  isOwner: boolean;
  onClose: () => void;
}

interface AddFormState {
  name: string;
  hubstaffOrgId: string;
}

interface EditFormState {
  name: string;
  hubstaffOrgId: string;
  taxId: string;
  address: string;
  phone: string;
  website: string;
  contacts: CompanyContact[];
}

/**
 * Clients management — modal body. Add / edit / archive the companies you
 * invoice. Assigning a contractor to a client is billing-only and never changes
 * pay; permanent delete is gated to empty clients via the server action.
 */
export const ClientsCard = ({ clients }: ClientsCardProps) => {
  const toast = useToast();
  const router = useRouter();
  const addNameId = useId();
  const addOrgId = useId();
  const editNameId = useId();
  const editOrgId = useId();
  const editTaxId = useId();
  const editAddressId = useId();
  const editPhoneId = useId();
  const editWebsiteId = useId();

  const [isPending, startTransition] = useTransition();
  const [addForm, setAddForm] = useState<AddFormState>({
    name: '',
    hubstaffOrgId: '',
  });
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditFormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CompanyFullRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const startEdit = (c: CompanyFullRow) => {
    setEditId(c.id);
    setEditForm({
      name: c.name,
      hubstaffOrgId: c.hubstaffOrgId == null ? '' : String(c.hubstaffOrgId),
      taxId: c.taxId ?? '',
      address: c.address ?? '',
      phone: c.phone ?? '',
      website: c.website ?? '',
      contacts: c.contacts,
    });
  };

  const cancelEdit = () => {
    setEditId(null);
    setEditForm(null);
  };

  const parseOrgId = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  };

  const handleAdd = () => {
    if (!addForm.name.trim()) {
      toast.notify('Company name is required.', { type: 'error' });
      return;
    }
    startTransition(async () => {
      try {
        const res = await saveClient({
          name: addForm.name.trim(),
          hubstaffOrgId: parseOrgId(addForm.hubstaffOrgId),
        });
        if (res.ok) {
          toast.notify('Client added.', { type: 'success' });
          setAddForm({ name: '', hubstaffOrgId: '' });
          router.refresh();
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to add client.', {
          type: 'error',
        });
      }
    });
  };

  const handleSaveEdit = (id: string) => {
    if (!editForm) return;
    if (!editForm.name.trim()) {
      toast.notify('Company name is required.', { type: 'error' });
      return;
    }
    startTransition(async () => {
      try {
        const res = await saveClient({
          id,
          name: editForm.name.trim(),
          hubstaffOrgId: parseOrgId(editForm.hubstaffOrgId),
          taxId: editForm.taxId.trim(),
          address: editForm.address.trim(),
          phone: editForm.phone.trim(),
          website: editForm.website.trim(),
          contacts: editForm.contacts,
        });
        if (res.ok) {
          toast.notify('Client saved.', { type: 'success' });
          cancelEdit();
          router.refresh();
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to save client.', { type: 'error' });
      }
    });
  };

  const handleStatusToggle = (c: CompanyFullRow) => {
    const next = c.status === 'active' ? 'inactive' : 'active';
    startTransition(async () => {
      try {
        const res = await setClientStatus({ id: c.id, status: next });
        if (res.ok) {
          toast.notify(next === 'active' ? 'Client unarchived.' : 'Client archived.', {
            type: 'success',
          });
          router.refresh();
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to update status.', {
          type: 'error',
        });
      }
    });
  };

  const handleDeleteConfirm = () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    startTransition(async () => {
      try {
        const res = await deleteClient({
          id: deleteTarget.id,
          confirmName: deleteTarget.name,
        });
        if (res.ok) {
          toast.notify(`${deleteTarget.name} deleted.`, { type: 'success' });
          setDeleteTarget(null);
          router.refresh();
        } else {
          toast.notify(res.error, { type: 'error' });
          setDeleteBusy(false);
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to delete client.', {
          type: 'error',
        });
        setDeleteBusy(false);
      }
    });
  };

  const columns: ReadonlyArray<SortableColumn<CompanyFullRow>> = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      cardTitle: true,
      accessor: (r) => r.name,
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      accessor: (r) => r.status,
      render: (r) => <Badge tone={r.status === 'active' ? 'good' : 'neutral'}>{r.status}</Badge>,
    },
    {
      key: 'hubstaff',
      label: 'Hubstaff',
      sortable: true,
      accessor: (r) => r.hubstaffOrgId ?? '',
      render: (r) =>
        r.hubstaffOrgId == null ? (
          <span className="muted">no Hubstaff link</span>
        ) : (
          <span>{r.hubstaffOrgId}</span>
        ),
    },
    {
      key: 'contacts',
      label: 'Contacts',
      sortable: true,
      accessor: (r) => r.contacts.length,
      render: (r) => r.contacts.length,
    },
    {
      key: 'actions',
      label: 'Actions',
      sortable: false,
      render: (r) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => (editId === r.id ? cancelEdit() : startEdit(r))}
          >
            {editId === r.id ? 'Cancel' : 'Edit'}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => handleStatusToggle(r)}
            disabled={isPending}
          >
            {r.status === 'active' ? 'Archive' : 'Unarchive'}
          </button>
          <button
            type="button"
            className="btn danger-outline sm"
            onClick={() => setDeleteTarget(r)}
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <p className="sub">
        Add/edit/archive the clients you invoice. Edit a client to set its tax ID, address, phone,
        website and contacts. Assigning a contractor to a client is billing-only and never changes
        their pay. Permanent delete is only for empty clients.
      </p>

      <div className="actionbar" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
        <strong style={{ marginBottom: 8 }}>Add a client</strong>
        <div className="row">
          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor={addNameId}>Company name</label>
            <input
              id={addNameId}
              type="text"
              value={addForm.name}
              onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Company name (required)"
              disabled={isPending}
            />
          </div>
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor={addOrgId}>Hubstaff org ID</label>
            <input
              id={addOrgId}
              type="number"
              value={addForm.hubstaffOrgId}
              onChange={(e) => setAddForm((f) => ({ ...f, hubstaffOrgId: e.target.value }))}
              placeholder="Hubstaff org ID (optional)"
              disabled={isPending}
            />
          </div>
        </div>
        <p className="sub" style={{ marginTop: 0 }}>
          Hubstaff org ID links the company for time sync (ID-first matching). Find it in Hubstaff →
          Organization settings, or leave blank and set it later via Edit.
        </p>
        <button
          type="button"
          className="btn"
          onClick={handleAdd}
          disabled={isPending || !addForm.name.trim()}
        >
          {isPending ? 'Adding…' : 'Add'}
        </button>
      </div>

      <strong style={{ display: 'block', margin: '8px 0' }}>
        Active ({clients.filter((c) => c.status === 'active').length})
      </strong>

      {clients.length === 0 ? (
        <EmptyState icon="🏢" message="No clients yet." />
      ) : (
        <SortableTable
          columns={columns}
          rows={clients}
          rowKey={(r) => r.id}
          filterable={clients.length > 5}
          filterPlaceholder="Filter clients…"
          emptyMessage="No clients match your filter."
        />
      )}

      {editId != null && editForm != null && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="row">
            <div className="field" style={{ minWidth: 220 }}>
              <label htmlFor={editNameId}>Company name</label>
              <input
                id={editNameId}
                type="text"
                value={editForm.name}
                onChange={(e) => setEditForm((f) => (f ? { ...f, name: e.target.value } : f))}
                disabled={isPending}
              />
            </div>
            <div className="field" style={{ minWidth: 160 }}>
              <label htmlFor={editOrgId}>Hubstaff org ID</label>
              <input
                id={editOrgId}
                type="number"
                value={editForm.hubstaffOrgId}
                onChange={(e) =>
                  setEditForm((f) => (f ? { ...f, hubstaffOrgId: e.target.value } : f))
                }
                placeholder="Optional"
                disabled={isPending}
              />
            </div>
          </div>
          <div className="row">
            <div className="field" style={{ minWidth: 160 }}>
              <label htmlFor={editTaxId}>Tax ID</label>
              <input
                id={editTaxId}
                type="text"
                value={editForm.taxId}
                onChange={(e) => setEditForm((f) => (f ? { ...f, taxId: e.target.value } : f))}
                disabled={isPending}
              />
            </div>
            <div className="field" style={{ minWidth: 220 }}>
              <label htmlFor={editWebsiteId}>Website</label>
              <input
                id={editWebsiteId}
                type="text"
                value={editForm.website}
                onChange={(e) => setEditForm((f) => (f ? { ...f, website: e.target.value } : f))}
                disabled={isPending}
              />
            </div>
          </div>
          <div className="row">
            <div className="field" style={{ minWidth: 220 }}>
              <label htmlFor={editAddressId}>Address</label>
              <input
                id={editAddressId}
                type="text"
                value={editForm.address}
                onChange={(e) => setEditForm((f) => (f ? { ...f, address: e.target.value } : f))}
                disabled={isPending}
              />
            </div>
            <div className="field" style={{ minWidth: 200 }}>
              <label htmlFor={editPhoneId}>Phone</label>
              <PhoneInput
                id={editPhoneId}
                value={editForm.phone}
                onChange={(value) => setEditForm((f) => (f ? { ...f, phone: value } : f))}
                defaultCountry="PH"
                disabled={isPending}
              />
            </div>
          </div>
          <ContactsEditor
            contacts={editForm.contacts}
            onChange={(next) => setEditForm((f) => (f ? { ...f, contacts: next } : f))}
          />
          <div className="actions">
            <button type="button" className="btn ghost" onClick={cancelEdit} disabled={isPending}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => handleSaveEdit(editId)}
              disabled={isPending || !editForm.name.trim()}
            >
              {isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {deleteTarget != null && (
        <ConfirmDangerModal
          title={`Permanently delete "${deleteTarget.name}"?`}
          message={`Permanently delete "${deleteTarget.name}"?`}
          consequence="This company has no payments, pay periods, time, rates, or contractor links. It will be removed completely. This cannot be undone."
          confirmWord={deleteTarget.name}
          confirmLabel="Delete permanently"
          busy={deleteBusy}
          onConfirm={handleDeleteConfirm}
          onCancel={() => {
            setDeleteTarget(null);
            setDeleteBusy(false);
          }}
        />
      )}
    </div>
  );
};
