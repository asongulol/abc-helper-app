'use client';

import { useState, useTransition } from 'react';
import { Badge, type BadgeTone, ConfirmDangerModal, useToast } from '@/components/ui';
import type { ClientOption } from '@/db/queries/invoicing';
import type { SessionRow } from '@/db/queries/sessions';
import { fmtDate } from '@/lib/format';
import {
  type ClientWorker,
  createSession,
  deleteSession,
  loadClientSessions,
  setSessionApproval,
} from '@/server/actions/sessions';

interface Props {
  clients: ClientOption[];
  defaultFrom: string;
  defaultTo: string;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'warn',
  approved: 'good',
  rejected: 'bad',
};

const labelStyle = { display: 'block', fontSize: 11 } as const;
const rightAlign = { textAlign: 'right' } as const;

export const SessionsClient = ({ clients, defaultFrom, defaultTo }: Props) => {
  const { notify } = useToast();
  const [clientId, setClientId] = useState('');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [roster, setRoster] = useState<ClientWorker[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [isLoading, startLoad] = useTransition();
  const [isSaving, startSave] = useTransition();
  const [isUpdating, startUpdate] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Add-session form.
  const [addWorkerId, setAddWorkerId] = useState('');
  const [addDate, setAddDate] = useState(defaultTo);
  const [addUnits, setAddUnits] = useState('1');
  const [addType, setAddType] = useState('');
  const [addCaseRef, setAddCaseRef] = useState('');
  const [addNotes, setAddNotes] = useState('');

  const clientName = clients.find((c) => c.id === clientId)?.name ?? '';

  const load = (cid = clientId) => {
    if (!cid) {
      notify('Pick a client first.', { type: 'warn' });
      return;
    }
    startLoad(async () => {
      const res = await loadClientSessions({ clientId: cid, from, to });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        setRoster(null);
        setSessions(null);
        return;
      }
      setRoster(res.data.roster);
      setSessions(res.data.sessions);
      setSelected(new Set());
    });
  };

  const reload = () => load(clientId);

  const addSession = () => {
    if (!addWorkerId) {
      notify('Pick a contractor.', { type: 'warn' });
      return;
    }
    const units = Number(addUnits);
    if (!Number.isInteger(units) || units < 1) {
      notify('Units must be a whole number ≥ 1.', { type: 'warn' });
      return;
    }
    startSave(async () => {
      const res = await createSession({
        clientId,
        workerId: addWorkerId,
        sessionDate: addDate,
        sessionType: addType.trim() || null,
        units,
        caseRef: addCaseRef.trim() || null,
        notes: addNotes.trim() || null,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify('Session added.', { type: 'success' });
      setAddType('');
      setAddCaseRef('');
      setAddNotes('');
      setAddUnits('1');
      reload();
    });
  };

  const approve = (id: string, status: 'approved' | 'rejected') => {
    startUpdate(async () => {
      const res = await setSessionApproval({ clientId, ids: [id], status });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      reload();
    });
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = (ids: string[], checked: boolean) =>
    setSelected(checked ? new Set(ids) : new Set());

  const bulkApprove = (status: 'approved' | 'rejected') => {
    const ids = [...selected];
    if (ids.length === 0) return;
    startUpdate(async () => {
      const res = await setSessionApproval({ clientId, ids, status });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(`${res.data.count} session${res.data.count === 1 ? '' : 's'} ${status}.`, {
        type: 'success',
      });
      reload();
    });
  };

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const doDelete = () => {
    const id = pendingDelete;
    if (!id) return;
    setPendingDelete(null);
    startUpdate(async () => {
      const res = await deleteSession({ clientId, id });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify('Session deleted.', { type: 'success' });
      reload();
    });
  };

  const approvedCount = sessions?.filter((s) => s.approval === 'approved').length ?? 0;
  const allSelected =
    !!sessions && sessions.length > 0 && sessions.every((s) => selected.has(s.id));

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Sessions</h2>
        <p className="sub">
          Record per-visit sessions for a client. Approved sessions bill at the contractor&apos;s
          flat session rate on the client&apos;s invoice (alongside any hourly time). A session is
          billed in whichever invoice window contains its date.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ minWidth: 200, flex: 1 }}>
            <span className="sub" style={labelStyle}>
              Client
            </span>
            <select
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                setRoster(null);
                setSessions(null);
                setSelected(new Set());
              }}
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
          <label>
            <span className="sub" style={labelStyle}>
              From
            </span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span className="sub" style={labelStyle}>
              To
            </span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn"
            disabled={isLoading || !clientId}
            onClick={() => load()}
          >
            {isLoading ? 'Loading…' : 'Load'}
          </button>
        </div>
      </div>

      {roster && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Add a session — {clientName}</h3>
          {roster.length === 0 ? (
            <p className="sub">
              This client has no active contractors. Assign one (with a session rate) in Contractors
              first.
            </p>
          ) : (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ minWidth: 180 }}>
                <span className="sub" style={labelStyle}>
                  Contractor
                </span>
                <select
                  value={addWorkerId}
                  onChange={(e) => setAddWorkerId(e.target.value)}
                  style={{ width: '100%' }}
                >
                  <option value="">— Select —</option>
                  {roster.map((w) => (
                    <option key={w.workerId} value={w.workerId}>
                      {w.workerName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="sub" style={labelStyle}>
                  Date
                </span>
                <input type="date" value={addDate} onChange={(e) => setAddDate(e.target.value)} />
              </label>
              <label>
                <span className="sub" style={labelStyle}>
                  Units
                </span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={addUnits}
                  onChange={(e) => setAddUnits(e.target.value)}
                  style={{ width: 70 }}
                />
              </label>
              <label>
                <span className="sub" style={labelStyle}>
                  Type
                </span>
                <input
                  value={addType}
                  onChange={(e) => setAddType(e.target.value)}
                  placeholder="e.g. follow-up"
                />
              </label>
              <label>
                <span className="sub" style={labelStyle}>
                  Case ref
                </span>
                <input value={addCaseRef} onChange={(e) => setAddCaseRef(e.target.value)} />
              </label>
              <label style={{ minWidth: 160, flex: 1 }}>
                <span className="sub" style={labelStyle}>
                  Notes
                </span>
                <input
                  value={addNotes}
                  onChange={(e) => setAddNotes(e.target.value)}
                  style={{ width: '100%' }}
                />
              </label>
              <button type="button" className="btn" disabled={isSaving} onClick={addSession}>
                {isSaving ? 'Adding…' : 'Add session'}
              </button>
            </div>
          )}
        </div>
      )}

      {sessions && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            Sessions {clientName ? `— ${clientName}` : ''}{' '}
            <span className="sub" style={{ fontWeight: 400 }}>
              ({approvedCount} approved / {sessions.length} total)
            </span>
          </h3>
          {selected.size > 0 && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                marginBottom: 12,
                flexWrap: 'wrap',
              }}
            >
              <span className="sub">{selected.size} selected</span>
              <button
                type="button"
                className="btn sm"
                disabled={isUpdating}
                onClick={() => bulkApprove('approved')}
              >
                Approve {selected.size}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={isUpdating}
                onClick={() => bulkApprove('rejected')}
              >
                Reject {selected.size}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={isUpdating}
                onClick={() => setSelected(new Set())}
              >
                Clear
              </button>
            </div>
          )}
          {sessions.length === 0 ? (
            <p className="sub">No sessions in this window.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 28 }}>
                      <input
                        type="checkbox"
                        aria-label="Select all sessions"
                        checked={allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = selected.size > 0 && !allSelected;
                        }}
                        onChange={(e) =>
                          toggleAll(
                            sessions.map((s) => s.id),
                            e.target.checked,
                          )
                        }
                      />
                    </th>
                    <th>Date</th>
                    <th>Contractor</th>
                    <th>Item</th>
                    <th>Child</th>
                    <th>EIID</th>
                    <th style={rightAlign}>Units</th>
                    <th>Case</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${s.workerName || 'session'} ${fmtDate(s.sessionDate)}`}
                          checked={selected.has(s.id)}
                          onChange={() => toggle(s.id)}
                        />
                      </td>
                      <td>{fmtDate(s.sessionDate)}</td>
                      <td>{s.workerName || '—'}</td>
                      <td>{s.sessionType ?? '—'}</td>
                      <td>{s.childInitials ?? '—'}</td>
                      <td>{s.eiid ?? '—'}</td>
                      <td style={rightAlign}>{s.units}</td>
                      <td>{s.caseRef ?? '—'}</td>
                      <td>
                        <Badge tone={STATUS_TONE[s.approval] ?? 'neutral'}>{s.approval}</Badge>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {s.approval !== 'approved' && (
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={isUpdating}
                              onClick={() => approve(s.id, 'approved')}
                            >
                              Approve
                            </button>
                          )}
                          {s.approval !== 'rejected' && (
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={isUpdating}
                              onClick={() => approve(s.id, 'rejected')}
                            >
                              Reject
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn danger-outline sm"
                            disabled={isUpdating}
                            onClick={() => setPendingDelete(s.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {pendingDelete != null && (
        <ConfirmDangerModal
          title="Delete session"
          message="Delete this session? It will be removed from billing."
          confirmLabel="Delete session"
          onConfirm={doDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
};
