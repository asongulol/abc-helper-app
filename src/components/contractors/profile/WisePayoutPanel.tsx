'use client';

/**
 * Wise payout panel (Profile → Pay & payout) — legacy parity for the
 * "Wise recipients" list + "External sources — Wise drift". Self-contained
 * (owns its own data + server actions), like RateCard, so it sits OUTSIDE the
 * profile form. Identifiers only; no money moves here.
 */

import { useEffect, useState, useTransition } from 'react';
import { Badge, Spinner } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { fullName } from '@/lib/names';
import { wiseGetRecipient } from '@/server/actions/wise';
import {
  addWorkerWiseContact,
  addWorkerWiseRecipient,
  applyWiseDriftToWorker,
  getWorkerWisePayout,
  lookupWiseByTag,
  removeWorkerWiseRecipient,
  saveWorkerWiseUuid,
  setDefaultWiseRecipient,
  type WisePayoutState,
} from '@/server/actions/wise-recipients';
import { SECTION_H4 } from './types';

const norm = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();

export function WisePayoutPanel({ workerId }: { workerId: string }) {
  const { notify } = useToast();
  const [state, setState] = useState<WisePayoutState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, startBusy] = useTransition();

  // Add-recipient form
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  // UUID field
  const [uuidDraft, setUuidDraft] = useState('');
  // Wise drift
  const [wise, setWise] = useState<{ name: string; email: string | null } | null>(null);
  const [wiseErr, setWiseErr] = useState('');
  const [wiseLoading, setWiseLoading] = useState(false);
  // Pull from Wise
  const [mode, setMode] = useState<'id' | 'tag'>('id');
  const [lookupVal, setLookupVal] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [results, setResults] = useState<{ id: number; name: string; uuid?: string }[]>([]);

  useEffect(() => {
    getWorkerWisePayout(workerId).then((res) => {
      if (res.ok) {
        setState(res.data);
        setUuidDraft(res.data.uuid ?? '');
      } else {
        notify(res.error, { type: 'error' });
      }
      setLoaded(true);
    });
  }, [workerId, notify]);

  const apply = (
    res: { ok: true; data: WisePayoutState } | { ok: false; error: string },
    okMsg: string,
  ) => {
    if (!res.ok) {
      notify(res.error, { type: 'error' });
      return;
    }
    setState(res.data);
    setUuidDraft(res.data.uuid ?? '');
    notify(okMsg, { type: 'success' });
  };

  const addRecipient = () =>
    startBusy(async () => {
      const id = Number(newId.trim());
      if (!Number.isInteger(id) || id <= 0) {
        notify('Enter a numeric Wise recipient ID.', { type: 'warn' });
        return;
      }
      const res = await addWorkerWiseRecipient({ workerId, recipientId: id, label: newLabel });
      apply(res, `Added recipient #${id}.`);
      if (res.ok) {
        setNewId('');
        setNewLabel('');
      }
    });

  const checkWise = () => {
    if (!state?.defaultId) return;
    setWiseLoading(true);
    setWiseErr('');
    void wiseGetRecipient(state.defaultId).then((res) => {
      setWiseLoading(false);
      if (!res.ok) {
        setWiseErr(res.error);
        setWise(null);
        return;
      }
      const r = res.data as { name?: string; email?: string | null };
      setWise({ name: r.name ?? '', email: r.email ?? null });
    });
  };

  const pullDrift = (field: 'name' | 'email') =>
    startBusy(async () => {
      if (!state?.defaultId) return;
      const res = await applyWiseDriftToWorker({ workerId, field, recipientId: state.defaultId });
      apply(res, `Pulled Wise ${field} into the DB.`);
    });

  const runLookup = () => {
    setLookupBusy(true);
    setResults([]);
    void (async () => {
      try {
        if (mode === 'id') {
          const id = Number(lookupVal.trim());
          if (!Number.isInteger(id) || id <= 0) {
            notify('Enter a numeric Wise recipient ID.', { type: 'warn' });
            return;
          }
          const res = await wiseGetRecipient(id);
          if (!res.ok) {
            notify(res.error, { type: 'error' });
            return;
          }
          const r = res.data as { id?: number; name?: string };
          setResults([{ id, name: r.name ?? `Recipient ${id}` }]);
        } else {
          const res = await lookupWiseByTag(lookupVal);
          if (!res.ok) {
            notify(res.error, { type: 'error' });
            return;
          }
          if (res.data.length === 0)
            notify('No Wise contact matched that Wisetag/name.', { type: 'warn' });
          setResults(res.data.map((c) => ({ id: c.recipientId, name: c.name, uuid: c.uuid })));
        }
      } finally {
        setLookupBusy(false);
      }
    })();
  };

  const addFromLookup = (r: { id: number; name: string; uuid?: string }) =>
    startBusy(async () => {
      // A Wisetag contact carries a UUID (the batch-CSV key) — store both ids;
      // a plain numeric recipient just gets added to the list.
      const res = r.uuid
        ? await addWorkerWiseContact({
            workerId,
            recipientId: r.id,
            uuid: r.uuid,
            label: r.name,
          })
        : await addWorkerWiseRecipient({ workerId, recipientId: r.id, label: r.name });
      apply(res, `Added ${r.name}.`);
      if (res.ok)
        setResults((rs) => rs.filter((x) => (x.uuid ?? String(x.id)) !== (r.uuid ?? String(r.id))));
    });

  if (!loaded) {
    return (
      <section style={{ marginTop: 24 }}>
        <h4 style={SECTION_H4}>Wise recipients (for payouts)</h4>
        <p className="muted">
          <Spinner /> Loading…
        </p>
      </section>
    );
  }
  if (!state) return null;

  const nameDrift = wise != null && norm(wise.name) !== norm(fullName(state));
  const emailDrift = wise != null && norm(wise.email) !== norm(state.email);

  return (
    <section className="modal-section" style={{ marginTop: 24 }}>
      <h4 style={SECTION_H4}>Wise recipients (for payouts)</h4>
      {state.recipients.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
          None yet. Add a recipient ID from your Wise account below.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <tbody>
              {state.recipients.map((rec) => (
                <tr key={rec.id}>
                  <td>
                    <b>{rec.label}</b> <span className="muted">#{rec.id}</span>
                  </td>
                  <td style={{ width: 150 }}>
                    {state.defaultId === rec.id ? (
                      <Badge tone="good">default (last used)</Badge>
                    ) : (
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busy}
                        onClick={() =>
                          startBusy(async () =>
                            apply(
                              await setDefaultWiseRecipient({ workerId, recipientId: rec.id }),
                              `#${rec.id} is now the default.`,
                            ),
                          )
                        }
                      >
                        Make default
                      </button>
                    )}
                  </td>
                  <td style={{ width: 80, textAlign: 'right' }}>
                    <button
                      type="button"
                      className="btn danger-outline sm"
                      disabled={busy}
                      onClick={() =>
                        startBusy(async () =>
                          apply(
                            await removeWorkerWiseRecipient({ workerId, recipientId: rec.id }),
                            `Removed #${rec.id}.`,
                          ),
                        )
                      }
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
        style={{ gap: 8, alignItems: 'flex-end', marginTop: 10, flexWrap: 'wrap' }}
      >
        <div className="field" style={{ minWidth: 130 }}>
          <label htmlFor="wr-id">Wise recipient ID</label>
          <input
            id="wr-id"
            inputMode="numeric"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="numeric ID"
            disabled={busy}
          />
        </div>
        <div className="field" style={{ minWidth: 150 }}>
          <label htmlFor="wr-label">Label (optional)</label>
          <input
            id="wr-label"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="e.g. BPI peso"
            disabled={busy}
          />
        </div>
        <button type="button" className="btn sm" onClick={addRecipient} disabled={busy}>
          Add
        </button>
      </div>

      <div
        className="row"
        style={{
          gap: 8,
          alignItems: 'flex-end',
          marginTop: 12,
          borderTop: '1px dashed var(--border)',
          paddingTop: 12,
        }}
      >
        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label htmlFor="wr-uuid">Wise recipient UUID (for manual Batch CSV)</label>
          <input
            id="wr-uuid"
            value={uuidDraft}
            onChange={(e) => setUuidDraft(e.target.value)}
            placeholder="e.g. 33e5a8b1-…  (Wise → Batch payments → Download all templates)"
            disabled={busy}
          />
        </div>
        <button
          type="button"
          className="btn sm"
          disabled={busy || uuidDraft.trim() === (state.uuid ?? '')}
          onClick={() =>
            startBusy(async () =>
              apply(
                await saveWorkerWiseUuid({ workerId, uuid: uuidDraft }),
                'Saved Wise recipient UUID.',
              ),
            )
          }
        >
          {uuidDraft.trim() && !state.uuid ? 'Save' : 'Update'}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        These are recipient IDs <b>in your Wise account</b> (identifiers only — never bank details).
        Payouts default to the one marked default; it updates to whichever was last used. The{' '}
        <b>UUID</b> is what the Manual Wise batch file uses — <b>By Wisetag</b> fills it in
        automatically, or paste it from the Wise <i>Batch payments → Download all templates</i> CSV.
      </p>

      {/* External sources — Wise drift */}
      <h4 style={{ ...SECTION_H4, marginTop: 20 }}>External sources — drift check</h4>
      <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
        What Wise has for this contractor vs the DB. Mismatches show ⚠️. The “Use Wise&apos;s …”
        button pulls Wise&apos;s value into the DB (Wise is the payment source of truth).
      </p>
      <div style={{ marginTop: 8 }}>
        <b>Wise</b>{' '}
        {state.defaultId == null ? (
          <span className="muted">not linked — add a recipient above first.</span>
        ) : (
          <button type="button" className="btn ghost sm" onClick={checkWise} disabled={wiseLoading}>
            {wiseLoading ? <Spinner /> : `Check #${state.defaultId}`}
          </button>
        )}
        {wiseErr && (
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {wiseErr}
          </p>
        )}
        {wise && (
          <table style={{ marginTop: 8 }}>
            <tbody>
              <tr>
                <td className="muted" style={{ width: 70 }}>
                  Name
                </td>
                <td>
                  {wise.name || '—'} {nameDrift && '⚠️'}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {nameDrift && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={busy}
                      onClick={() => pullDrift('name')}
                    >
                      Use Wise&apos;s name
                    </button>
                  )}
                </td>
              </tr>
              <tr>
                <td className="muted">Email</td>
                <td>
                  {wise.email || '—'} {emailDrift && '⚠️'}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {emailDrift && wise.email && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={busy}
                      onClick={() => pullDrift('email')}
                    >
                      Use Wise&apos;s email
                    </button>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* Pull from Wise */}
      <div className="card" style={{ marginTop: 12, background: 'var(--surface-2)', padding: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Pull from Wise</div>
        <div className="row" style={{ gap: 6, marginBottom: 6 }}>
          <button
            type="button"
            className={`btn sm ${mode === 'id' ? '' : 'ghost'}`}
            aria-pressed={mode === 'id'}
            onClick={() => {
              setMode('id');
              setResults([]);
            }}
          >
            By recipient ID
          </button>
          <button
            type="button"
            className={`btn sm ${mode === 'tag' ? '' : 'ghost'}`}
            aria-pressed={mode === 'tag'}
            onClick={() => {
              setMode('tag');
              setResults([]);
            }}
          >
            By Wisetag
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '0 0 6px' }}>
          {mode === 'id'
            ? 'Paste the numeric Wise recipient ID (e.g. 1372559053) — the standard route for bank-account payouts.'
            : 'Search your Wise contacts by Wisetag or name (Wise-to-Wise / balance recipients). Adding one stores the UUID the manual Batch CSV needs — no paste required.'}
        </p>
        <div className="row" style={{ gap: 6, alignItems: 'flex-end' }}>
          <input
            value={lookupVal}
            onChange={(e) => setLookupVal(e.target.value)}
            placeholder={mode === 'id' ? 'numeric Wise recipient ID' : '@wisetag or name'}
            aria-label={
              mode === 'id' ? 'Wise recipient ID' : 'Search Wise contacts by Wisetag or name'
            }
            style={{ maxWidth: 260 }}
            disabled={lookupBusy}
          />
          <button
            type="button"
            className="btn sm"
            onClick={runLookup}
            disabled={lookupBusy || !lookupVal.trim()}
          >
            {lookupBusy ? <Spinner /> : 'Look up'}
          </button>
        </div>
        {results.length > 0 && (
          <table style={{ marginTop: 8 }}>
            <tbody>
              {results.map((r) => {
                const added = r.uuid
                  ? state.uuid === r.uuid
                  : state.recipients.some((x) => x.id === r.id);
                return (
                  <tr key={r.uuid ?? r.id}>
                    <td>
                      <b>{r.name}</b>{' '}
                      <span className="muted">
                        {r.uuid ? `${r.uuid.slice(0, 8)}…` : `#${r.id}`}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy || added}
                        onClick={() => addFromLookup(r)}
                      >
                        {added ? 'Added' : 'Add'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
