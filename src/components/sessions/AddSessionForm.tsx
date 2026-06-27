'use client';

/**
 * Admin "Add session" form for per-session contractors — the same fields a
 * contractor enters in the portal (client, child initials, EIID, item/type,
 * date) plus a worker picker and units, creating a real service_sessions row.
 * The CLIENT is required (it's the company billed → invoicing). Admin entry is
 * authoritative, so it defaults to Approved (pays/bills without a review step).
 *
 * Reused in two places: the Time & Approval screen (own worker picker) and the
 * Calculate batch's session modal (worker controlled by the parent — pass
 * `workerId` to hide the picker).
 */

import { useEffect, useId, useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import type { PortalSessionRow, WorkerClient } from '@/db/queries/sessions';
import { fmtDate } from '@/lib/format';
import { getOffCycleEligibleWorkers, type OffCycleEligibleWorker } from '@/server/actions/payroll';
import { createSession, getWorkerClients, getWorkerSessions } from '@/server/actions/sessions';
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
  const [approve, setApprove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<PortalSessionRow[]>([]);

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
      setClientId(list.length === 1 ? (list[0]?.id ?? '') : '');
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

  const canSubmit =
    !!workerId && !!clientId && childInitials.trim() !== '' && eiid.trim() !== '' && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = await createSession({
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
      notify(`Session added${approve ? ' (approved)' : ' — pending'}.`, { type: 'success' });
      // Keep worker/client/date; clear the per-child fields for fast repeat entry.
      setChildInitials('');
      setEiid('');
      await reloadRecent(workerId);
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

        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
          <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
          Approved
        </label>

        <button type="button" className="btn sm" disabled={!canSubmit} onClick={submit}>
          {busy ? 'Adding…' : 'Add session'}
        </button>
      </div>

      {workerId && recent.length > 0 && (
        <div className="table-scroll" style={{ marginTop: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Client</th>
                <th>Type</th>
                <th>Child</th>
                <th>EIID</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((s) => (
                <tr key={s.id}>
                  <td>{fmtDate(s.sessionDate)}</td>
                  <td>{s.companyName}</td>
                  <td>{s.item ?? '—'}</td>
                  <td>{s.childInitials ?? '—'}</td>
                  <td>{s.eiid ?? '—'}</td>
                  <td>
                    <Badge tone={STATUS_TONE[s.approval] ?? 'neutral'}>{s.approval}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};
