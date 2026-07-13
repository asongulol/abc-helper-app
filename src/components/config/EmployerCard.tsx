'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { ContactsEditor } from '@/components/config/ContactsEditor';
import { Badge, PhoneInput, useToast } from '@/components/ui';
import type { CompanyContact, CompanyFullRow } from '@/db/queries/config';
import { saveEmployer } from '@/server/actions/config';

interface EmployerCardProps {
  employer: CompanyFullRow | null;
  onClose: () => void;
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

const parseOrgId = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

/**
 * Validate the Hubstaff org ID field. Blank is allowed (no link); a non-numeric
 * entry used to be silently discarded to null under a "Saved" toast (#027), so
 * surface it as an error instead. Must be a positive integer.
 */
const orgIdError = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? null : 'Hubstaff org ID must be a positive number.';
};

/**
 * Employer modal body (manifest 22) — mirrors the legacy CompaniesModal with
 * `kind="employer"`: an "Add an employer (tenant)" card, then the single active
 * employer listed with its details and an inline Edit. The employer is the
 * payroll home, so it is never archived/deleted — only Add and Edit appear.
 */
export const EmployerCard = ({ employer }: EmployerCardProps) => {
  const toast = useToast();
  const router = useRouter();
  const addNameId = useId();
  const addOrgId = useId();
  const editNameId = useId();
  const editTaxId = useId();
  const editOrgId = useId();
  const editAddressId = useId();
  const editPhoneId = useId();
  const editWebsiteId = useId();

  const [isPending, startTransition] = useTransition();
  const [addName, setAddName] = useState('');
  const [addOrg, setAddOrg] = useState('');
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditFormState | null>(null);

  const startEdit = (c: CompanyFullRow) => {
    setEditing(true);
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
    setEditing(false);
    setEditForm(null);
  };

  const handleAdd = () => {
    if (!addName.trim()) {
      toast.notify('Enter a company name.', { type: 'error' });
      return;
    }
    const orgErr = orgIdError(addOrg);
    if (orgErr) {
      toast.notify(orgErr, { type: 'error' });
      return;
    }
    startTransition(async () => {
      try {
        const res = await saveEmployer({
          name: addName.trim(),
          hubstaffOrgId: parseOrgId(addOrg),
        });
        if (res.ok) {
          toast.notify(`Added "${addName.trim()}".`, { type: 'success' });
          setAddName('');
          setAddOrg('');
          router.refresh();
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to add employer.', {
          type: 'error',
        });
      }
    });
  };

  const handleSaveEdit = () => {
    if (!editForm || !employer) return;
    if (!editForm.name.trim()) {
      toast.notify("Name can't be empty.", { type: 'error' });
      return;
    }
    const orgErr = orgIdError(editForm.hubstaffOrgId);
    if (orgErr) {
      toast.notify(orgErr, { type: 'error' });
      return;
    }
    startTransition(async () => {
      try {
        const res = await saveEmployer({
          id: employer.id,
          name: editForm.name.trim(),
          hubstaffOrgId: parseOrgId(editForm.hubstaffOrgId),
          taxId: editForm.taxId.trim(),
          address: editForm.address.trim(),
          phone: editForm.phone.trim(),
          website: editForm.website.trim(),
          contacts: editForm.contacts,
        });
        if (res.ok) {
          toast.notify(`Saved "${editForm.name.trim()}".`, { type: 'success' });
          cancelEdit();
          router.refresh();
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to save employer.', {
          type: 'error',
        });
      }
    });
  };

  const orgTxt =
    employer?.hubstaffOrgId != null ? `Hubstaff org ${employer.hubstaffOrgId}` : 'no Hubstaff link';
  const detailParts = employer
    ? [
        employer.taxId ? `Tax ID ${employer.taxId}` : null,
        employer.phone,
        employer.website,
        employer.address,
      ].filter((p): p is string => Boolean(p))
    : [];

  return (
    <div>
      <p className="sub">
        The payroll home for every contractor (Aaron Anderson E.H.S. LLC). Edit it to set its
        Hubstaff org link, tax ID, address, phone, website and contacts. It is never billed and
        can't be archived/deleted.
      </p>

      <div className="card" style={{ marginTop: 6 }}>
        <b>Add an employer (tenant)</b>
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
            marginTop: 8,
          }}
        >
          <input
            id={addNameId}
            type="text"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="Company name (required)"
            aria-label="New company name"
            style={{ minWidth: 200, flex: 1 }}
            disabled={isPending}
          />
          <input
            id={addOrgId}
            type="text"
            inputMode="numeric"
            value={addOrg}
            onChange={(e) => setAddOrg(e.target.value)}
            placeholder="Hubstaff org ID (optional)"
            aria-label="New company Hubstaff org ID"
            style={{ minWidth: 170 }}
            disabled={isPending}
          />
          <button
            type="button"
            className="btn"
            onClick={handleAdd}
            disabled={isPending || !addName.trim()}
          >
            Add
          </button>
        </div>
        <div className="sub" style={{ fontSize: 11.5, marginTop: 6 }}>
          Hubstaff org ID links the company for time sync (ID-first matching). Find it in Hubstaff →
          Organization settings, or leave blank and set it later via Edit.
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="ov-tile-label" style={{ marginBottom: 2 }}>
          Active ({employer ? 1 : 0})
        </div>
        {employer == null ? (
          <div className="sub" style={{ padding: '8px 0' }}>
            No active companies.
          </div>
        ) : editing && editForm != null ? (
          <div style={{ borderTop: '1px solid var(--border)', padding: '12px 0' }}>
            <div className="row">
              <div className="field" style={{ minWidth: 0 }}>
                <label htmlFor={editNameId}>Company name</label>
                <input
                  id={editNameId}
                  type="text"
                  value={editForm.name}
                  onChange={(e) => setEditForm((f) => (f ? { ...f, name: e.target.value } : f))}
                  disabled={isPending}
                />
              </div>
              <div className="field" style={{ minWidth: 0 }}>
                <label htmlFor={editTaxId}>Tax ID (EIN / TIN)</label>
                <input
                  id={editTaxId}
                  type="text"
                  value={editForm.taxId}
                  onChange={(e) => setEditForm((f) => (f ? { ...f, taxId: e.target.value } : f))}
                  placeholder="e.g. 12-3456789"
                  disabled={isPending}
                />
              </div>
              <div className="field" style={{ minWidth: 0 }}>
                <label htmlFor={editOrgId}>Hubstaff org ID (optional)</label>
                <input
                  id={editOrgId}
                  type="text"
                  inputMode="numeric"
                  value={editForm.hubstaffOrgId}
                  onChange={(e) =>
                    setEditForm((f) => (f ? { ...f, hubstaffOrgId: e.target.value } : f))
                  }
                  placeholder="e.g. 258598"
                  disabled={isPending}
                />
              </div>
            </div>
            <div className="row">
              <div className="field" style={{ minWidth: 0, flex: '2 1 0' }}>
                <label htmlFor={editAddressId}>Address</label>
                <input
                  id={editAddressId}
                  type="text"
                  value={editForm.address}
                  onChange={(e) => setEditForm((f) => (f ? { ...f, address: e.target.value } : f))}
                  placeholder="Street, city, state ZIP"
                  disabled={isPending}
                />
              </div>
              <div className="field" style={{ minWidth: 0, flex: '2 1 0' }}>
                <label htmlFor={editPhoneId}>Phone</label>
                <PhoneInput
                  id={editPhoneId}
                  value={editForm.phone}
                  onChange={(v) => setEditForm((f) => (f ? { ...f, phone: v } : f))}
                  defaultCountry="US"
                  disabled={isPending}
                />
              </div>
              <div className="field" style={{ minWidth: 0 }}>
                <label htmlFor={editWebsiteId}>Website</label>
                <input
                  id={editWebsiteId}
                  type="text"
                  value={editForm.website}
                  onChange={(e) => setEditForm((f) => (f ? { ...f, website: e.target.value } : f))}
                  placeholder="https://…"
                  disabled={isPending}
                />
              </div>
            </div>
            <ContactsEditor
              contacts={editForm.contacts}
              onChange={(next) => setEditForm((f) => (f ? { ...f, contacts: next } : f))}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="btn sm"
                onClick={handleSaveEdit}
                disabled={isPending}
              >
                {isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={cancelEdit}
                disabled={isPending}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            className="row"
            style={{
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
              borderTop: '1px solid var(--border)',
              padding: '10px 0',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ minWidth: 200 }}>
              <div
                style={{
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {employer.name} <Badge tone="good">Active</Badge>
              </div>
              <div className="sub" style={{ fontSize: 12 }}>
                {orgTxt} · currently selected
              </div>
              {(detailParts.length > 0 || employer.contacts.length > 0) && (
                <div className="sub" style={{ fontSize: 11.5, marginTop: 2 }}>
                  {detailParts.join(' · ')}
                  {employer.contacts.length > 0
                    ? `${detailParts.length > 0 ? ' · ' : ''}${employer.contacts.length} contact${
                        employer.contacts.length === 1 ? '' : 's'
                      }`
                    : ''}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => startEdit(employer)}
                disabled={isPending}
              >
                Edit
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
