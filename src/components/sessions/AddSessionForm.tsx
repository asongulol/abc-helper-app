'use client';

/**
 * Admin "Add session" form for per-session contractors — the same fields a
 * contractor enters in the portal (client, child initials, EIID, item/type,
 * date) plus a worker picker and units, creating a real service_sessions row.
 * The CLIENT is required (it's the company billed → invoicing). Sessions are
 * added as `pending` for a review pass; tick Approved to skip review.
 *
 * Reused in two places: the Time & Approval screen (own worker picker) and the
 * Calculate batch's session modal (worker controlled by the parent — pass
 * `workerId` to hide the picker).
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import type { PortalSessionRow, RecentSessionRow, WorkerClient } from '@/db/queries/sessions';
import { clientAlias } from '@/lib/clients';
import { fmtDate } from '@/lib/format';
import {
  getOffCycleEligibleWorkers,
  getRecentSessions,
  type OffCycleEligibleWorker,
} from '@/server/actions/payroll';
import {
  createSession,
  deleteSession,
  getWorkerClients,
  getWorkerSessions,
  updateSession,
} from '@/server/actions/sessions';
import { EI_SESSION_ITEMS } from '@/types/schemas/sessions';

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'warn',
  approved: 'good',
  rejected: 'bad',
};

interface AddSessionFormProps {
  companyId: string;
  /** When set, the worker is fixed (no picker) — used inside the Calculate modal. */
  workerId?: string;
  defaultDate: string;
  onCreated: () => void;
}

const lbl = { display: 'block', fontSize: 11, color: 'var(--muted)' } as const;

export const AddSessionForm = ({
  companyId,
  workerId: fixedWorkerId,
  defaultDate,
  onCreated,
}: AddSessionFormProps) => {
  const { notify } = useToast();
  const idWorker = useId();
  const idClient = useId();
  const idChild = useId();
  const idEiid = useId();
  const idDate = useId();
  const idType = useId();
  const idUnits = useId();

  const controlled = !!fixedWorkerId;
  const [workers, setWorkers] = useState<OffCycleEligibleWorker[] | null>(controlled ? [] : null);
  const [pickedWorker, setPickedWorker] = useState('');
  const workerId = fixedWorkerId ?? pickedWorker;

  const [clients, setClients] = useState<WorkerClient[]>([]);
  const [loadingClients, setLoadingClients] = useState(false);
  const [clientId, setClientId] = useState('');
  const [childInitials, setChildInitials] = useState('');
  const [eiid, setEiid] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [type, setType] = useState<string>(EI_SESSION_ITEMS[0]);
  const [units, setUnits] = useState('1');
  // Default OFF so admin-entered sessions land as `pending` for a review pass
  // before they bill/pay (tick Approved to skip review).
  const [approve, setApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<PortalSessionRow[]>([]);
  // Employer-wide "Recently added" list (uncontrolled mode) — always visible so a
  // just-entered session shows without re-picking its contractor.
  const [recentAll, setRecentAll] = useState<RecentSessionRow[] | null>(controlled ? [] : null);
  // Non-null while editing a pending session (the submit becomes "Save changes").
  const [editingId, setEditingId] = useState<string | null>(null);
  // When editing a row for a different contractor, the worker switch reloads the
  // client list (which resets clientId) — stash the target so we can re-apply it.
  const pendingClientId = useRef<string | null>(null);

  const reloadRecent = async (wid: string) => {
    if (!wid) {
      setRecent([]);
      return;
    }
    const res = await getWorkerSessions({ companyId, workerId: wid });
    setRecent(res.ok ? res.data.sessions : []);
  };

  // Worker picker options (per-session only) — only when not controlled.
  useEffect(() => {
    if (controlled) return;
    let live = true;
    getOffCycleEligibleWorkers({ companyId }).then((res) => {
      if (!live) return;
      setWorkers(res.ok ? res.data.workers.filter((w) => w.basis === 'per_session') : []);
    });
    return () => {
      live = false;
    };
  }, [companyId, controlled]);

  // #1: remember the last-picked contractor across navigation so the entered
  // (pending) sessions stay visible on return — until they're approved/deleted.
  useEffect(() => {
    if (controlled) return;
    try {
      const saved = window.localStorage.getItem(`abc.addsession.worker.${companyId}`);
      if (saved) setPickedWorker(saved);
    } catch {
      /* localStorage unavailable (private mode) — non-fatal */
    }
  }, [companyId, controlled]);

  useEffect(() => {
    if (controlled || !pickedWorker) return;
    try {
      window.localStorage.setItem(`abc.addsession.worker.${companyId}`, pickedWorker);
    } catch {
      /* non-fatal */
    }
  }, [companyId, controlled, pickedWorker]);

  // Load the worker's assigned clients (the invoicing target options).
  useEffect(() => {
    if (!workerId) {
      setClients([]);
      setClientId('');
      return;
    }
    let live = true;
    setLoadingClients(true);
    getWorkerClients({ companyId, workerId }).then((res) => {
      if (!live) return;
      const list = res.ok ? res.data.clients : [];
      setClients(list);
      if (pendingClientId.current && list.some((c) => c.id === pendingClientId.current)) {
        setClientId(pendingClientId.current);
      } else {
        setClientId(list.length === 1 ? (list[0]?.id ?? '') : '');
      }
      pendingClientId.current = null;
      setLoadingClients(false);
    });
    return () => {
      live = false;
    };
  }, [companyId, workerId]);

  // The selected worker's recent sessions (so a just-added one is visible).
  useEffect(() => {
    if (!workerId) {
      setRecent([]);
      return;
    }
    let live = true;
    getWorkerSessions({ companyId, workerId }).then((res) => {
      if (!live) return;
      setRecent(res.ok ? res.data.sessions : []);
    });
    return () => {
      live = false;
    };
  }, [companyId, workerId]);

  // Employer-wide "Recently added" list — fetched on mount, then after each
  // add/edit/delete so it always reflects what was just entered (uncontrolled).
  const reloadAll = async () => {
    if (controlled) return;
    const res = await getRecentSessions({ companyId });
    setRecentAll(res.ok ? res.data.sessions : []);
  };
  useEffect(() => {
    if (controlled) return;
    let live = true;
    getRecentSessions({ companyId }).then((res) => {
      if (live) setRecentAll(res.ok ? res.data.sessions : []);
    });
    return () => {
      live = false;
    };
  }, [companyId, controlled]);

  const canSubmit =
    !!workerId && !!clientId && childInitials.trim() !== '' && eiid.trim() !== '' && !busy;

  const resetEntryFields = () => {
    setChildInitials('');
    setEiid('');
    setUnits('1');
  };

  const cancelEdit = () => {
    setEditingId(null);
    resetEntryFields();
  };

  // Load a pending session back into the form for editing. `workerId` is present
  // on employer-wide rows — switching contractor reloads clients, so the target
  // client is stashed in pendingClientId and re-applied once they load.
  const startEdit = (s: {
    id: string;
    companyId: string;
    childInitials: string | null;
    eiid: string | null;
    sessionDate: string;
    item: string | null;
    units: number;
    workerId?: string;
  }) => {
    setEditingId(s.id);
    if (!controlled && s.workerId && s.workerId !== pickedWorker) {
      pendingClientId.current = s.companyId;
      setPickedWorker(s.workerId);
    } else {
      setClientId(s.companyId);
    }
    setChildInitials(s.childInitials ?? '');
    setEiid(s.eiid ?? '');
    setDate(s.sessionDate);
    setType(s.item ?? EI_SESSION_ITEMS[0]);
    setUnits(String(s.units || 1));
  };

  const removeSession = async (s: { id: string; companyId: string }) => {
    setBusy(true);
    try {
      const res = await deleteSession({ clientId: s.companyId, id: s.id });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      if (editingId === s.id) cancelEdit();
      notify('Session deleted.', { type: 'success' });
      await reloadRecent(workerId);
      await reloadAll();
      onCreated();
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = editingId
        ? await updateSession({
            clientId,
            id: editingId,
            sessionDate: date,
            sessionType: type,
            units: Math.max(1, Number(units) || 1),
            childInitials: childInitials.trim(),
            eiid: eiid.trim(),
          })
        : await createSession({
            clientId,
            workerId,
            sessionDate: date,
            sessionType: type,
            units: Math.max(1, Number(units) || 1),
            childInitials: childInitials.trim(),
            eiid: eiid.trim(),
            approve,
          });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(
        editingId ? 'Session updated.' : `Session added${approve ? ' (approved)' : ' — pending'}.`,
        { type: 'success' },
      );
      // Keep worker/client/date; clear the per-child fields for fast repeat entry.
      setEditingId(null);
      resetEntryFields();
      await reloadRecent(workerId);
      await reloadAll();
      onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {!controlled && (
          <label htmlFor={idWorker} style={{ minWidth: 180 }}>
            <span style={lbl}>Contractor (per session)</span>
            {workers === null ? (
              <Spinner />
            ) : (
              <select
                id={idWorker}
                value={pickedWorker}
                onChange={(e) => setPickedWorker(e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="">— select —</option>
                {workers.map((w) => (
                  <option key={w.workerId} value={w.workerId}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}

        <label style={{ minWidth: 180, flex: 1 }}>
          <span style={lbl}>Client (billed)</span>
          <select
            id={idClient}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            disabled={!workerId || loadingClients}
            style={{ width: '100%' }}
          >
            <option value="">{loadingClients ? 'Loading…' : '— select a client —'}</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label style={{ minWidth: 110 }}>
          <span style={lbl}>Child initials</span>
          <input
            id={idChild}
            value={childInitials}
            onChange={(e) => setChildInitials(e.target.value)}
            maxLength={12}
            placeholder="e.g. J.D."
            style={{ width: '100%' }}
          />
        </label>

        <label style={{ minWidth: 130 }}>
          <span style={lbl}>EIID</span>
          <input
            id={idEiid}
            value={eiid}
            onChange={(e) => setEiid(e.target.value)}
            maxLength={40}
            placeholder="Early-Intervention ID"
            style={{ width: '100%' }}
          />
        </label>

        <label>
          <span style={lbl}>Date</span>
          <input id={idDate} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>

        <label style={{ minWidth: 150 }}>
          <span style={lbl}>Session type</span>
          <select
            id={idType}
            value={type}
            onChange={(e) => setType(e.target.value)}
            style={{ width: '100%' }}
          >
            {EI_SESSION_ITEMS.map((it) => (
              <option key={it} value={it}>
                {it}
              </option>
            ))}
          </select>
        </label>

        <label style={{ width: 70 }}>
          <span style={lbl}>Units</span>
          <input
            id={idUnits}
            type="number"
            min={1}
            step={1}
            value={units}
            onChange={(e) => setUnits(e.target.value)}
            style={{ width: '100%' }}
          />
        </label>

        {!editingId && (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <input
              type="checkbox"
              checked={approve}
              onChange={(e) => setApprove(e.target.checked)}
            />
            Approved
          </label>
        )}

        <button type="button" className="btn sm" disabled={!canSubmit} onClick={submit}>
          {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add session'}
        </button>
        {editingId && (
          <button type="button" className="btn ghost sm" disabled={busy} onClick={cancelEdit}>
            Cancel
          </button>
        )}
      </div>

      {controlled && workerId && recent.length > 0 && (
        <div className="table-scroll" style={{ marginTop: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Client</th>
                <th>Type</th>
                <th>Child</th>
                <th>EIID</th>
                <th style={{ textAlign: 'right' }}>Units</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {recent.map((s) => {
                const pending = s.approval === 'pending';
                return (
                  <tr key={s.id} style={editingId === s.id ? { background: '#eff6ff' } : undefined}>
                    <td>{fmtDate(s.sessionDate)}</td>
                    <td>{clientAlias(s.companyName)}</td>
                    <td>{s.item ?? '—'}</td>
                    <td>{s.childInitials ?? '—'}</td>
                    <td>{s.eiid ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>{s.units}</td>
                    <td>
                      <Badge tone={STATUS_TONE[s.approval] ?? 'neutral'}>{s.approval}</Badge>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {pending ? (
                        <>
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={busy}
                            onClick={() => startEdit(s)}
                          >
                            Edit
                          </button>{' '}
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={busy}
                            style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
                            onClick={() => removeSession(s)}
                          >
                            Delete
                          </button>
                        </>
                      ) : (
                        <span className="muted" style={{ fontSize: 11 }}>
                          locked
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!controlled && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ margin: '0 0 6px', fontSize: 14 }}>Recently added sessions</h4>
          {recentAll === null ? (
            <Spinner />
          ) : recentAll.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>
              No sessions yet — add one above.
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Contractor</th>
                    <th>Client</th>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Child</th>
                    <th>EIID</th>
                    <th style={{ textAlign: 'right' }}>Units</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {recentAll.map((s) => {
                    const pending = s.approval === 'pending';
                    return (
                      <tr
                        key={s.id}
                        style={editingId === s.id ? { background: '#eff6ff' } : undefined}
                      >
                        <td>{s.workerName}</td>
                        <td>{clientAlias(s.companyName)}</td>
                        <td>{fmtDate(s.sessionDate)}</td>
                        <td>{s.item ?? '—'}</td>
                        <td>{s.childInitials ?? '—'}</td>
                        <td>{s.eiid ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{s.units}</td>
                        <td>
                          <Badge tone={STATUS_TONE[s.approval] ?? 'neutral'}>{s.approval}</Badge>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {pending ? (
                            <>
                              <button
                                type="button"
                                className="btn ghost sm"
                                disabled={busy}
                                onClick={() => startEdit(s)}
                              >
                                Edit
                              </button>{' '}
                              <button
                                type="button"
                                className="btn ghost sm"
                                disabled={busy}
                                style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
                                onClick={() => removeSession(s)}
                              >
                                Delete
                              </button>
                            </>
                          ) : (
                            <span className="muted" style={{ fontSize: 11 }}>
                              locked
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
};
