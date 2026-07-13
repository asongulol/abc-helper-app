'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge, type BadgeTone, useToast } from '@/components/ui';
import type { PortalSessionRow, WorkerClient } from '@/db/queries/sessions';
import { fmtDate } from '@/lib/format';
import { createContractorSession } from '@/server/actions/portal-sessions';
import { EI_SESSION_ITEMS } from '@/types/schemas/sessions';

interface Props {
  clients: WorkerClient[];
  sessions: PortalSessionRow[];
  defaultDate: string;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'warn',
  approved: 'good',
  rejected: 'bad',
};

const labelStyle = { display: 'block', fontSize: 11 } as const;

export const PortalSessions = ({ clients, sessions, defaultDate }: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [isSaving, startSave] = useTransition();

  const [clientId, setClientId] = useState(clients.length === 1 ? (clients[0]?.id ?? '') : '');
  const [childInitials, setChildInitials] = useState('');
  const [eiid, setEiid] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [item, setItem] = useState<string>(EI_SESSION_ITEMS[0]);

  const submit = () => {
    if (!clientId) {
      notify('Pick a client.', { type: 'warn' });
      return;
    }
    if (!childInitials.trim() || !eiid.trim()) {
      notify('Child initials and EIID are required.', { type: 'warn' });
      return;
    }
    startSave(async () => {
      const submitOnce = (confirmDuplicate: boolean) =>
        createContractorSession({
          clientId,
          sessionDate: date,
          item,
          childInitials: childInitials.trim(),
          eiid: eiid.trim(),
          confirmDuplicate,
        });
      let res = await submitOnce(false);
      if (!res.ok && res.error.startsWith('DUPLICATE_SESSION:')) {
        const msg = res.error.replace('DUPLICATE_SESSION:', '').trim();
        if (!window.confirm(`${msg} Add it anyway?`)) return;
        res = await submitOnce(true);
      }
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify('Session submitted — pending approval.', { type: 'success' });
      setChildInitials('');
      setEiid('');
      setItem(EI_SESSION_ITEMS[0]);
      router.refresh();
    });
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Sessions</h2>
        <p className="sub">
          Record your Early-Intervention sessions. Each entry is submitted for admin approval before
          it&apos;s billed.
        </p>
      </div>

      {clients.length === 0 ? (
        <div className="card">
          <p className="sub" style={{ margin: 0 }}>
            You&apos;re not assigned to any client yet. Contact your payroll admin.
          </p>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Add a session</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ minWidth: 180, flex: 1 }}>
              <span className="sub" style={labelStyle}>
                Client
              </span>
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="">— Select a client —</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ minWidth: 120 }}>
              <span className="sub" style={labelStyle}>
                Child initials
              </span>
              <input
                value={childInitials}
                onChange={(e) => setChildInitials(e.target.value)}
                maxLength={12}
                placeholder="e.g. J.D."
                style={{ width: '100%' }}
              />
            </label>
            <label style={{ minWidth: 140 }}>
              <span className="sub" style={labelStyle}>
                EIID
              </span>
              <input
                value={eiid}
                onChange={(e) => setEiid(e.target.value)}
                maxLength={40}
                placeholder="Early-Intervention ID"
                style={{ width: '100%' }}
              />
            </label>
            <label>
              <span className="sub" style={labelStyle}>
                Date
              </span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label style={{ minWidth: 170 }}>
              <span className="sub" style={labelStyle}>
                Item
              </span>
              <select
                value={item}
                onChange={(e) => setItem(e.target.value)}
                style={{ width: '100%' }}
              >
                {EI_SESSION_ITEMS.map((it) => (
                  <option key={it} value={it}>
                    {it}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn" disabled={isSaving} onClick={submit}>
              {isSaving ? 'Submitting…' : 'Submit session'}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Your sessions</h3>
        {sessions.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            No sessions submitted yet.
          </p>
        ) : (
          <div className="table-scroll">
            <table aria-label="Your sessions">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Client</th>
                  <th scope="col">Item</th>
                  <th scope="col">Child</th>
                  <th scope="col">EIID</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td data-label="Date">{fmtDate(s.sessionDate)}</td>
                    <td data-label="Client">{s.companyName}</td>
                    <td data-label="Item">{s.item ?? '—'}</td>
                    <td data-label="Child">{s.childInitials ?? '—'}</td>
                    <td data-label="EIID">{s.eiid ?? '—'}</td>
                    <td data-label="Status">
                      <Badge tone={STATUS_TONE[s.approval] ?? 'neutral'}>{s.approval}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
};
