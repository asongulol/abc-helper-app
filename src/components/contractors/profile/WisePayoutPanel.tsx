'use client';

/**
 * Wise payout panel (Profile → Pay & payout) — the contractor's Wise recipients
 * in PRIORITY order (default first, then failovers), a search over the Wise
 * account so recipients are picked from what Wise already has, a "Verify with
 * Wise" pass, and the "External sources — Wise drift" check. Self-contained
 * (owns its own data + server actions), like RateCard, so it sits OUTSIDE the
 * profile form. Identifiers only; no money moves here.
 */

import { useEffect, useState, useTransition } from 'react';
import { Badge, Spinner } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { fullName } from '@/lib/names';
import { entryKey } from '@/lib/wise/recipients';
import { wiseGetRecipient } from '@/server/actions/wise';
import {
  addWorkerWiseRecipient,
  applyWiseDriftToWorker,
  getWorkerWisePayout,
  moveWiseRecipientUp,
  removeWorkerWiseRecipient,
  saveWorkerWiseUuid,
  searchWiseRecipients,
  setDefaultWiseRecipient,
  verifyWorkerWiseRecipients,
  type WisePayoutState,
} from '@/server/actions/wise-recipients';
import type { RecipientCheck, WiseRecipientHit } from '@/server/wise/service';
import { SECTION_H4 } from './types';

const norm = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();
const short = (uuid: string | null): string => (uuid ? `${uuid.slice(0, 8)}…` : '—');

const CHECK_TONE: Record<RecipientCheck['status'], 'good' | 'bad' | 'warn'> = {
  ok: 'good',
  missing: 'bad',
  inactive: 'bad',
  unverified: 'warn',
};

export function WisePayoutPanel({ workerId, isOwner }: { workerId: string; isOwner: boolean }) {
  const { notify } = useToast();
  const [state, setState] = useState<WisePayoutState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, startBusy] = useTransition();
  // RP-55: every write in wise-recipients.ts is owner-only, so disable the
  // write controls instead of letting a non-owner click into an error toast.
  // Reads (drift check, Wise search, verify) stay open to any admin.
  const locked = busy || !isOwner;

  // Per-entry UUID edit: which row is open, and its draft value.
  const [uuidEdit, setUuidEdit] = useState<{ key: string; value: string } | null>(null);
  // Verify with Wise
  const [checks, setChecks] = useState<Record<string, RecipientCheck>>({});
  const [verifying, setVerifying] = useState(false);
  // Wise drift
  const [wise, setWise] = useState<{ name: string; email: string | null } | null>(null);
  const [wiseErr, setWiseErr] = useState('');
  const [wiseLoading, setWiseLoading] = useState(false);
  // Search the Wise account
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<WiseRecipientHit[] | null>(null);

  useEffect(() => {
    getWorkerWisePayout(workerId).then((res) => {
      if (res.ok) setState(res.data);
      else notify(res.error, { type: 'error' });
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
    setUuidEdit(null);
    setChecks({}); // the list changed — a verify result no longer describes it
    notify(okMsg, { type: 'success' });
  };

  const verify = () => {
    setVerifying(true);
    void verifyWorkerWiseRecipients(workerId).then((res) => {
      setVerifying(false);
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      setChecks(Object.fromEntries(res.data.map((c) => [c.key, c])));
      const bad = res.data.filter((c) => c.status !== 'ok');
      notify(
        bad.length
          ? `${bad.length} of ${res.data.length} recipient(s) need attention.`
          : `All ${res.data.length} recipient(s) verified with Wise.`,
        { type: bad.length ? 'warn' : 'success' },
      );
    });
  };

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

  const runSearch = () => {
    setSearching(true);
    void searchWiseRecipients(query).then((res) => {
      setSearching(false);
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      setHits(res.data);
    });
  };

  const addHit = (h: WiseRecipientHit) =>
    startBusy(async () => {
      const res = await addWorkerWiseRecipient({
        workerId,
        recipientId: h.id,
        uuid: h.uuid,
        label: h.name,
      });
      apply(res, `Added ${h.name}.`);
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
  const onList = (h: WiseRecipientHit) =>
    state.recipients.some(
      (e) => (h.uuid != null && e.uuid === h.uuid) || (h.id != null && e.id === h.id),
    );

  return (
    <section className="modal-section" style={{ marginTop: 24 }}>
      <h4 style={SECTION_H4}>Wise recipients (for payouts)</h4>
      {!isOwner && (
        <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
          Read-only — only the owner can change payout identifiers, because they decide where this
          contractor&apos;s pay is sent.
        </p>
      )}
      {state.recipients.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
          None yet. Find this contractor in your Wise account below.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Priority</th>
                <th scope="col">Recipient</th>
                <th scope="col">Batch-CSV UUID</th>
                <th scope="col">Wise</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {state.recipients.map((rec, i) => {
                const key = entryKey(rec);
                const check = checks[key];
                const editing = uuidEdit?.key === key;
                return (
                  <tr key={key}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {i === 0 ? (
                        <Badge tone="good">default</Badge>
                      ) : (
                        <Badge tone="neutral">failover {i}</Badge>
                      )}
                    </td>
                    <td>
                      <b>{rec.label}</b>{' '}
                      <span className="muted">{rec.id != null ? `#${rec.id}` : 'no API id'}</span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {editing ? (
                        <span style={{ display: 'inline-flex', gap: 4 }}>
                          <input
                            aria-label={`Batch-CSV UUID for ${rec.label}`}
                            value={uuidEdit.value}
                            onChange={(e) => setUuidEdit({ key, value: e.target.value })}
                            placeholder="paste from the Wise batch template"
                            style={{ width: 300, fontSize: 12 }}
                            disabled={locked}
                          />
                          <button
                            type="button"
                            className="btn sm"
                            disabled={locked}
                            onClick={() =>
                              startBusy(async () =>
                                apply(
                                  await saveWorkerWiseUuid({ workerId, key, uuid: uuidEdit.value }),
                                  'Saved Batch-CSV UUID.',
                                ),
                              )
                            }
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => setUuidEdit(null)}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <>
                          <span className="muted" title={rec.uuid ?? undefined}>
                            {short(rec.uuid)}
                          </span>{' '}
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={locked}
                            onClick={() => setUuidEdit({ key, value: rec.uuid ?? '' })}
                          >
                            {rec.uuid ? 'edit' : 'add'}
                          </button>
                        </>
                      )}
                    </td>
                    <td>
                      {check ? (
                        <span title={check.detail}>
                          <Badge tone={CHECK_TONE[check.status]}>{check.status}</Badge>
                          {check.wiseName && (
                            <span className="muted" style={{ marginLeft: 4, fontSize: 12 }}>
                              {check.wiseName}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {i > 0 && (
                        <>
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={locked}
                            onClick={() =>
                              startBusy(async () =>
                                apply(
                                  await setDefaultWiseRecipient({ workerId, key }),
                                  `${rec.label} is now the default.`,
                                ),
                              )
                            }
                          >
                            Make default
                          </button>{' '}
                          {i > 1 && (
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={locked}
                              aria-label={`Move ${rec.label} up`}
                              onClick={() =>
                                startBusy(async () =>
                                  apply(
                                    await moveWiseRecipientUp({ workerId, key }),
                                    'Reordered failovers.',
                                  ),
                                )
                              }
                            >
                              ↑
                            </button>
                          )}{' '}
                        </>
                      )}
                      <button
                        type="button"
                        className="btn danger-outline sm"
                        disabled={locked}
                        onClick={() =>
                          startBusy(async () =>
                            apply(
                              await removeWorkerWiseRecipient({ workerId, key }),
                              `Removed ${rec.label}.`,
                            ),
                          )
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {state.recipients.length > 0 && (
        <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
          <button type="button" className="btn ghost sm" onClick={verify} disabled={verifying}>
            {verifying ? <Spinner /> : 'Verify with Wise'}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            Checks each recipient still exists and is active in Wise before payroll relies on it.
          </span>
        </div>
      )}
      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Identifiers <b>in your Wise account</b> — never bank details. The <b>default</b> is used
        first; if Wise rejects it (a Wisetag that can&apos;t take a bank transfer), the API draft
        falls back to the next one in order. The <b>Batch-CSV UUID</b> is what the manual Wise batch
        file uses — Wisetag contacts get it from the search; for a bank account paste it from Wise →{' '}
        <i>Batch payments → Download all templates</i>. The file uses the first recipient that has
        one.
      </p>

      {/* Find in Wise */}
      <div className="card" style={{ marginTop: 12, background: 'var(--surface-2)', padding: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Find in Wise</div>
        <p className="muted" style={{ fontSize: 12, margin: '0 0 6px' }}>
          Search the recipients your Wise account already has — bank accounts and Wisetag contacts —
          by name, @wisetag, or numeric recipient ID. Adding one stores what Wise knows about it.
        </p>
        <div className="row" style={{ gap: 6, alignItems: 'flex-end' }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim()) runSearch();
            }}
            placeholder="name, @wisetag, or recipient ID"
            aria-label="Search Wise recipients"
            style={{ maxWidth: 300 }}
            disabled={searching}
          />
          <button
            type="button"
            className="btn sm"
            onClick={runSearch}
            disabled={searching || !query.trim()}
          >
            {searching ? <Spinner /> : 'Search'}
          </button>
        </div>
        {hits && hits.length === 0 && (
          <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Nothing in Wise matched. Add the recipient in Wise first, then search again.
          </p>
        )}
        {hits && hits.length > 0 && (
          <table style={{ marginTop: 8 }}>
            <tbody>
              {hits.map((h) => {
                const added = onList(h);
                return (
                  <tr key={h.uuid ?? String(h.id)}>
                    <td style={{ width: 90 }}>
                      <Badge tone="neutral">{h.kind === 'bank' ? 'bank' : 'Wisetag'}</Badge>
                    </td>
                    <td>
                      <b>{h.name}</b>{' '}
                      <span className="muted">
                        {[h.detail, h.id != null ? `#${h.id}` : null, h.uuid ? short(h.uuid) : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={locked || added}
                        onClick={() => addHit(h)}
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
                      disabled={locked}
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
                      disabled={locked}
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
    </section>
  );
}
