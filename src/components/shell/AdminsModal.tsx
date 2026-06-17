'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { EmailInput, Modal, useToast } from '@/components/ui';
import type { AdminRow } from '@/db/queries/admins';
import { addAdmin, removeAdmin, setAdminRole } from '@/server/actions/admin-manage';

export interface AdminsModalProps {
  /** All admin_users with company scope (server-fetched in the admin layout). */
  admins: ReadonlyArray<AdminRow>;
  /** Companies assignable to a non-owner admin. */
  companyOptions: ReadonlyArray<{ id: string; name: string }>;
  /** The signed-in owner's user id — used to mark "(you)" and gate self-edits. */
  meId: string;
  onClose: () => void;
}

const PILL: React.CSSProperties = {
  marginLeft: 6,
  display: 'inline-block',
  padding: '1px 8px',
  borderRadius: 999,
  background: '#eef2f7',
  color: 'var(--text)',
  fontSize: 11,
};

/** Toggle-chip styling for a company assignment (on = navy fill). */
function chipStyle(on: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '3px 9px',
    borderRadius: 999,
    cursor: 'pointer',
    lineHeight: 1.4,
    border: `1px solid ${on ? 'var(--navy)' : 'var(--border)'}`,
    background: on ? 'var(--navy)' : '#fff',
    color: on ? '#fff' : 'var(--text)',
  };
}

/**
 * Admins modal — owner-only overlay opened from the topbar "Admins" button.
 * Faithful port of the legacy AdminsModal: add by work email (even before first
 * sign-in), assign companies to non-owner admins, promote/demote, and remove.
 * Reuses the existing admin-manage server actions (addAdmin / removeAdmin /
 * setAdminRole); after each write it refreshes the server-rendered data.
 */
export const AdminsModal = ({ admins, companyOptions, meId, onClose }: AdminsModalProps) => {
  const toast = useToast();
  const router = useRouter();
  const [busy, startBusy] = useTransition();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState('admin');
  const [inviteCos, setInviteCos] = useState<string[]>([]);

  const run = (
    work: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>,
  ) =>
    startBusy(async () => {
      try {
        const res = await work();
        if (res.ok) {
          if (res.message) toast.notify(res.message, { type: 'success' });
          router.refresh();
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Something went wrong.', {
          type: 'error',
        });
      }
    });

  const add = () => {
    const e = email.trim().toLowerCase();
    if (!e) {
      toast.notify('Enter an email.', { type: 'error' });
      return;
    }
    run(async () => {
      const res = await addAdmin({
        email: e,
        role,
        companyIds: role === 'admin' ? inviteCos : [],
      });
      if (res.ok) {
        setEmail('');
        setRole('admin');
        setInviteCos([]);
      }
      return res;
    });
  };

  const changeRole = (admin: AdminRow, newRole: string) =>
    run(() => setAdminRole({ email: admin.email, role: newRole }));

  const toggleCountersign = (admin: AdminRow, val: boolean) =>
    run(() =>
      setAdminRole({
        email: admin.email,
        role: admin.role,
        canCountersign: val,
      }),
    );

  const remove = (admin: AdminRow) => {
    if (
      !window.confirm(
        `Remove admin access for ${admin.email}? They'll keep their Google account but lose access to this app.`,
      )
    ) {
      return;
    }
    run(() => removeAdmin({ email: admin.email }));
  };

  const reassign = (admin: AdminRow, next: string[]) =>
    run(() => addAdmin({ email: admin.email, role: admin.role, companyIds: next }));

  /** Company toggle chips for a non-owner admin (driven off their current scope). */
  const companyPicker = (admin: AdminRow) => {
    const set = new Set(admin.companyIds);
    return (
      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          alignItems: 'center',
          marginTop: 6,
        }}
      >
        <span className="muted" style={{ fontSize: 11 }}>
          Companies:
        </span>
        {companyOptions.length === 0 && (
          <span className="muted" style={{ fontSize: 11 }}>
            add a company first
          </span>
        )}
        {companyOptions.map((c) => {
          const on = set.has(c.id);
          return (
            <button
              key={c.id}
              type="button"
              disabled={busy}
              aria-pressed={on}
              onClick={() =>
                reassign(
                  admin,
                  on ? admin.companyIds.filter((x) => x !== c.id) : [...admin.companyIds, c.id],
                )
              }
              style={chipStyle(on)}
            >
              {on ? '✓ ' : ''}
              {c.name}
            </button>
          );
        })}
        {companyOptions.length > 0 && set.size === 0 && (
          <span style={{ fontSize: 11, color: 'var(--bad)' }}>no access until assigned</span>
        )}
      </div>
    );
  };

  return (
    <Modal title="Admins" onClose={onClose} maxWidth={560}>
      <p className="sub">
        Add anyone by their work email — even before they've signed in. They get access the moment
        they first sign in with Google (allowed domains: <b>abckidsny.com</b>, <b>abbilabs.com</b>).{' '}
        <b>Owners</b> manage this list and see all companies; <b>admins</b> see only the companies
        you assign below (and nothing until you assign at least one).
      </p>

      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          alignItems: 'center',
          margin: '8px 0',
        }}
      >
        <EmailInput
          pin={['abckidsny.com', 'abbilabs.com']}
          style={{ flex: 1, minWidth: 200, padding: '6px 8px' }}
          placeholder="name@abckidsny.com"
          value={email}
          onChange={setEmail}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) add();
          }}
        />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="admin">Admin</option>
          <option value="owner">Owner</option>
        </select>
        <button type="button" className="btn sm" disabled={busy} onClick={add}>
          {busy ? '…' : 'Add'}
        </button>
      </div>

      {role === 'admin' ? (
        <div
          style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            alignItems: 'center',
            margin: '0 0 8px',
          }}
        >
          <span className="muted" style={{ fontSize: 11 }}>
            Assign companies:
          </span>
          {companyOptions.length === 0 && (
            <span className="muted" style={{ fontSize: 11 }}>
              add a company first
            </span>
          )}
          {companyOptions.map((c) => {
            const on = inviteCos.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                disabled={busy}
                aria-pressed={on}
                onClick={() =>
                  setInviteCos((s) => (on ? s.filter((x) => x !== c.id) : [...s, c.id]))
                }
                style={chipStyle(on)}
              >
                {on ? '✓ ' : ''}
                {c.name}
              </button>
            );
          })}
          {companyOptions.length > 0 && inviteCos.length === 0 && (
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              optional — you can also assign after they appear below
            </span>
          )}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 11, margin: '0 0 8px' }}>
          Owners see all companies — no assignment needed.
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        {admins.map((a) => {
          const isMe = a.userId === meId;
          return (
            <div key={a.userId} style={{ borderTop: '1px solid #e5e7eb', padding: '8px 0' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <b>{a.email}</b>
                  <span style={PILL}>{a.role}</span>
                  {isMe && (
                    <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                      (you)
                    </span>
                  )}
                </div>
                {isMe ? (
                  <span className="muted" style={{ fontSize: 11 }}>
                    another owner manages your access
                  </span>
                ) : (
                  <div style={{ display: 'flex', gap: 6 }}>
                    {a.role === 'admin' ? (
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busy}
                        onClick={() => changeRole(a, 'owner')}
                      >
                        Make owner
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busy}
                        onClick={() => changeRole(a, 'admin')}
                      >
                        Make admin
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={busy}
                      onClick={() => remove(a)}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  marginTop: 6,
                  flexWrap: 'wrap',
                }}
              >
                <label
                  style={{
                    fontSize: 11,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={a.canCountersign !== false}
                    disabled={busy}
                    onChange={(ev) => toggleCountersign(a, ev.target.checked)}
                  />{' '}
                  Can countersign agreements
                </label>
              </div>
              {a.role === 'owner' ? (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  Owner · all companies
                </div>
              ) : (
                companyPicker(a)
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
};
