'use client';

import { useState, useTransition } from 'react';
import type { RosterWorker, WiseRecipientRef } from '@/db/queries/workers';
import { saveWiseRecipients, saveWiseRecipientUuid } from '@/server/actions/contractors';
import { SECTION_H4 } from './profile/types';

type Props = {
  worker: RosterWorker;
  companyId: string;
};

/**
 * Wise payout recipients (identifiers only — never bank details) + the separate
 * Wise recipient UUID used by the manual Batch CSV. Faithful port of the legacy
 * Pay & payout recipients block (`addRecip`/`removeRecip`/`makeDefault`/`persistUuid`).
 *
 * Local state seeds from the worker prop; the parent passes `key={worker.workerId}`
 * so switching contractors remounts (and re-seeds) the card.
 */
export function WiseRecipientsCard({ worker, companyId }: Props) {
  const [recips, setRecips] = useState<WiseRecipientRef[]>(worker.wiseRecipients ?? []);
  const [defId, setDefId] = useState<number | null>(worker.wiseRecipientId);
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [uuidDraft, setUuidDraft] = useState(worker.wiseRecipientUuid ?? '');
  const [defUuid, setDefUuid] = useState(worker.wiseRecipientUuid ?? '');
  const [msg, setMsg] = useState('');
  const [isPending, startTransition] = useTransition();

  function persist(next: WiseRecipientRef[], nextDef: number | null) {
    startTransition(async () => {
      const res = await saveWiseRecipients({
        workerId: worker.workerId,
        companyId,
        recipients: next,
        defaultId: nextDef,
      });
      if (!res.ok) {
        setMsg(res.error);
        return;
      }
      setRecips(next);
      setDefId(nextDef);
      setMsg('Saved.');
    });
  }

  function addRecip() {
    const id = Number(newId);
    if (!newId || Number.isNaN(id) || id <= 0) {
      setMsg('Enter a numeric Wise recipient ID.');
      return;
    }
    if (recips.some((x) => x.id === id)) {
      setMsg('Already added.');
      return;
    }
    const next: WiseRecipientRef[] = [
      ...recips,
      { id, label: newLabel.trim() || `Recipient ${id}` },
    ];
    const nextDef = defId ?? id;
    setNewId('');
    setNewLabel('');
    persist(next, nextDef);
  }

  function removeRecip(id: number) {
    const next = recips.filter((x) => x.id !== id);
    const nextDef = defId === id ? (next[0]?.id ?? null) : defId;
    persist(next, nextDef);
  }

  function makeDefault(id: number) {
    persist(recips, id);
  }

  function persistUuid() {
    const value = uuidDraft.trim() || null;
    startTransition(async () => {
      const res = await saveWiseRecipientUuid({
        workerId: worker.workerId,
        companyId,
        recipientUuid: value,
      });
      if (!res.ok) {
        setMsg(res.error);
        return;
      }
      setDefUuid(value ?? '');
      setMsg(value ? 'Saved Wise recipient UUID.' : 'Cleared Wise recipient UUID.');
    });
  }

  const uuidTrimmed = uuidDraft.trim();
  const uuidUnchanged = uuidTrimmed === defUuid;
  const uuidLabel = uuidTrimmed && !defUuid ? 'Save' : 'Update';

  return (
    <div>
      <h4 style={SECTION_H4}>Wise recipients (for payouts)</h4>

      {recips.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
          None yet. Add a recipient ID from your Wise account below.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <tbody>
              {recips.map((rec) => (
                <tr key={rec.id}>
                  <td>
                    <b>{rec.label}</b> <span className="muted">#{rec.id}</span>
                  </td>
                  <td style={{ width: 150 }}>
                    {defId === rec.id ? (
                      <span className="pill good">default (last used)</span>
                    ) : (
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={isPending}
                        onClick={() => makeDefault(rec.id)}
                      >
                        Make default
                      </button>
                    )}
                  </td>
                  <td style={{ width: 80, textAlign: 'right' }}>
                    <button
                      type="button"
                      className="btn ghost sm"
                      style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
                      disabled={isPending}
                      onClick={() => removeRecip(rec.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div
        className="row"
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 8 }}
      >
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="wr-id">Wise recipient ID</label>
          <input
            id="wr-id"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="numeric ID"
            disabled={isPending}
            style={{ width: 130 }}
          />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="wr-label">Label (optional)</label>
          <input
            id="wr-label"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="e.g. BPI peso"
            disabled={isPending}
            style={{ width: 160 }}
          />
        </div>
        <button type="button" className="btn sm" disabled={isPending} onClick={addRecip}>
          Add
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
          marginTop: 12,
          borderTop: '1px dashed var(--border)',
          paddingTop: 12,
        }}
      >
        <div className="field" style={{ margin: 0, flex: 1 }}>
          <label htmlFor="wr-uuid">Wise recipient UUID (for manual Batch CSV)</label>
          <input
            id="wr-uuid"
            value={uuidDraft}
            onChange={(e) => setUuidDraft(e.target.value)}
            placeholder="e.g. 33e5a8b1-…  (paste from Wise → Batch payments → Download all templates)"
            disabled={isPending}
            style={{ width: '100%' }}
          />
        </div>
        <button
          type="button"
          className="btn sm"
          disabled={isPending || uuidUnchanged}
          onClick={persistUuid}
        >
          {uuidLabel}
        </button>
      </div>

      {msg && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {msg}
        </div>
      )}

      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        These are recipient IDs <b>in your Wise account</b> (identifiers only — never bank details).
        Payouts default to the one marked default; it updates to whichever was last used. The{' '}
        <b>UUID</b> is separate — the Wise API doesn't return it, so paste it once from the Wise{' '}
        <i>Batch payments → Download all templates</i> CSV; it's what the Manual Wise batch file
        uses.
      </p>
    </div>
  );
}
