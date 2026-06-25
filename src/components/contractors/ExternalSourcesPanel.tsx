'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import type { RosterWorker } from '@/db/queries/workers';
import { linkWiseRecipient, pullFromWise } from '@/server/actions/contractors';
import { hubstaffGetUser } from '@/server/actions/hubstaff';
import { wiseGetRecipient, wiseSearchContacts } from '@/server/actions/wise';
import type { HubstaffUser } from '@/server/hubstaff/client';
import type { ContactResult, WiseRecipient } from '@/server/wise/service';
import { SECTION_H4 } from './profile/types';

type Props = {
  worker: RosterWorker;
  companyId: string;
};

type Preview = {
  id: number;
  name: string;
  email: string | null;
  currency: string | null;
  account: string | null;
  active: boolean;
  fromContact: boolean;
};

const WISE_BALANCE_NOTE =
  "Wisetag / Wise-balance recipient — Wise's read API doesn't expose this type, so drift check isn't available. Payments still work via the API draft.";

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();
const orDash = (s: string | null | undefined): string => (s?.trim() ? s : '—');

/**
 * External-sources drift check (Wise + Hubstaff) + Pull-from-Wise lookup.
 * Faithful port of the legacy `ExternalSourcesPanel`. Wise is the payment
 * source of truth, so Wise drift offers a one-click pull into the DB; Hubstaff
 * is read-only (its public API rejects profile edits) so it only links out.
 */
export function ExternalSourcesPanel({ worker, companyId }: Props) {
  const wiseId = worker.wiseRecipientId;
  const hubUserId = worker.hubstaffUserId;
  const dbName = [worker.firstName, worker.middleName, worker.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  const dbEmail = worker.email;

  const [wise, setWise] = useState<WiseRecipient | null>(null);
  const [wiseErr, setWiseErr] = useState('');
  const [wiseNote, setWiseNote] = useState('');
  const [isWiseLoading, startWise] = useTransition();

  const [hub, setHub] = useState<HubstaffUser | null>(null);
  const [hubErr, setHubErr] = useState('');
  const [isHubLoading, startHub] = useTransition();

  const [pushing, setPushing] = useState<string | null>(null);
  const [pushMsg, setPushMsg] = useState('');
  const [isPushPending, startPush] = useTransition();

  const [lookupMode, setLookupMode] = useState<'id' | 'tag'>('id');
  const [lookupInput, setLookupInput] = useState('');
  const [lookupErr, setLookupErr] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [results, setResults] = useState<ContactResult[] | null>(null);
  const [applyName, setApplyName] = useState(true);
  const [applyEmail, setApplyEmail] = useState(true);
  const [isLookupPending, startLookup] = useTransition();

  const loadWise = useCallback(() => {
    if (!wiseId) return;
    startWise(async () => {
      setWiseErr('');
      setWiseNote('');
      const res = await wiseGetRecipient(wiseId);
      if (!res.ok) {
        // 403/422 from Wise = a Wisetag/balance recipient the read API won't expose.
        if (/40[13]|422/.test(res.error)) setWiseNote(WISE_BALANCE_NOTE);
        else setWiseErr(res.error);
        return;
      }
      setWise(res.data as WiseRecipient);
    });
  }, [wiseId]);

  const loadHub = useCallback(() => {
    if (!hubUserId) return;
    startHub(async () => {
      setHubErr('');
      const res = await hubstaffGetUser({ userId: hubUserId });
      if (!res.ok) {
        setHubErr(res.error);
        return;
      }
      setHub(res.data ?? null);
    });
  }, [hubUserId]);

  // Loaders re-run when the stored Wise/Hubstaff id changes (i.e. on contractor switch).
  useEffect(() => {
    loadWise();
    loadHub();
  }, [loadWise, loadHub]);

  const wiseNameDiff = wise != null && norm(wise.name) !== norm(dbName);
  const wiseEmailDiff = wise != null && !!wise.email && norm(wise.email) !== norm(dbEmail);
  const hubNameDiff = hub != null && norm(hub.name) !== norm(dbName);
  const hubEmailDiff = hub != null && !!hub.email && norm(hub.email) !== norm(dbEmail);

  function pull(field: 'name' | 'email') {
    const value = field === 'name' ? wise?.name : wise?.email;
    if (!value) {
      setPushMsg(`Wise has no ${field} to pull.`);
      return;
    }
    setPushing(`wise_${field}`);
    setPushMsg('');
    startPush(async () => {
      const res = await pullFromWise({ workerId: worker.workerId, companyId, field, value });
      setPushing(null);
      if (!res.ok) {
        setPushMsg(`Pull failed: ${res.error}`);
        return;
      }
      setPushMsg(
        `Pulled ${field} from Wise into DB. Re-open the profile to see the updated fields.`,
      );
    });
  }

  function lookupById() {
    const id = lookupInput.trim().replace(/^#/, '');
    if (!/^\d+$/.test(id)) {
      setLookupErr('Enter a numeric Wise recipient ID (e.g. 1372559053).');
      return;
    }
    setLookupErr('');
    setPreview(null);
    setResults(null);
    startLookup(async () => {
      const res = await wiseGetRecipient(Number(id));
      if (!res.ok) {
        setLookupErr(res.error);
        return;
      }
      const r = res.data as WiseRecipient;
      setPreview({
        id: r.id,
        name: r.name,
        email: r.email,
        currency: r.currency,
        account: r.account,
        active: r.active,
        fromContact: false,
      });
    });
  }

  function lookupByTag() {
    const tag = lookupInput.trim().replace(/^@/, '');
    if (!tag) {
      setLookupErr('Enter a Wisetag (with or without the @).');
      return;
    }
    setLookupErr('');
    setPreview(null);
    setResults(null);
    startLookup(async () => {
      const res = await wiseSearchContacts(tag);
      if (!res.ok) {
        setLookupErr(res.error);
        return;
      }
      if (res.data.length === 0) {
        setLookupErr(`No contacts matched "${tag}".`);
        return;
      }
      setResults(res.data);
    });
  }

  function doLookup() {
    if (lookupMode === 'id') lookupById();
    else lookupByTag();
  }

  function pickContact(c: ContactResult) {
    setPreview({
      id: Number(c.balanceRecipientId),
      name: c.name || c.accountHolderName || '',
      email: null,
      currency: null,
      account: 'Wise balance',
      active: !c.hidden,
      fromContact: true,
    });
  }

  function clearLookup() {
    setPreview(null);
    setResults(null);
    setLookupInput('');
    setLookupErr('');
  }

  function setMode(mode: 'id' | 'tag') {
    setLookupMode(mode);
    setLookupErr('');
    setPreview(null);
    setResults(null);
  }

  function linkResult() {
    if (!preview) return;
    startLookup(async () => {
      const res = await linkWiseRecipient({
        workerId: worker.workerId,
        companyId,
        recipientId: preview.id,
        name: preview.name || null,
        email: preview.email,
        applyName,
        applyEmail,
        fromContact: preview.fromContact,
      });
      if (!res.ok) {
        setLookupErr(res.error);
        return;
      }
      setPushMsg(
        res.message ??
          `Linked Wise recipient #${preview.id}. Re-open the profile to see the updated fields.`,
      );
      clearLookup();
    });
  }

  const pullTitle =
    "Use Wise's value — overwrites the DB value. Wise is the payment source of truth. (Hubstaff isn't updated — its API doesn't support it; fix Hubstaff separately in their UI if needed.)";

  return (
    <div>
      <h4 style={SECTION_H4}>External sources — drift check</h4>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        What Wise and Hubstaff have for this contractor. Mismatches show ⚠️. For <b>Wise</b> drift,
        the "Use Wise's …" button pulls Wise's value into the DB (Wise is the payment source of
        truth). For <b>Hubstaff</b> drift, fix it in Hubstaff's web UI — Hubstaff's public API
        doesn't accept user-profile edits.
      </p>

      {/* ── Wise ───────────────────────────────────────────────────────── */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong>Wise</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            {wiseId ? `recipient #${wiseId}` : 'not linked'}
          </span>
          {wiseId != null && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={isWiseLoading}
              onClick={loadWise}
            >
              {isWiseLoading ? 'Loading…' : 'Refresh'}
            </button>
          )}
        </div>
        {wiseErr && (
          <div className="field-err" style={{ marginTop: 6 }}>
            Wise: {wiseErr}
          </div>
        )}
        {wiseNote && (
          <p className="muted" style={{ fontSize: 12, fontStyle: 'italic', marginTop: 6 }}>
            {wiseNote}
          </p>
        )}
        {wise && (
          <div className="table-scroll" style={{ marginTop: 6 }}>
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>DB</th>
                  <th>Wise</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Name</td>
                  <td>{orDash(dbName)}</td>
                  <td>
                    {orDash(wise.name)}{' '}
                    {wiseNameDiff && <span title="DB and external value differ">⚠️</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {wiseNameDiff && (
                      <button
                        type="button"
                        className="btn ghost sm"
                        title={pullTitle}
                        disabled={isPushPending}
                        onClick={() => pull('name')}
                      >
                        {pushing === 'wise_name' ? 'Pulling…' : "Use Wise's name"}
                      </button>
                    )}
                  </td>
                </tr>
                <tr>
                  <td>Email</td>
                  <td>{orDash(dbEmail)}</td>
                  <td>
                    {orDash(wise.email)}{' '}
                    {wiseEmailDiff && <span title="DB and external value differ">⚠️</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {wiseEmailDiff && (
                      <button
                        type="button"
                        className="btn ghost sm"
                        title={pullTitle}
                        disabled={isPushPending}
                        onClick={() => pull('email')}
                      >
                        {pushing === 'wise_email' ? 'Pulling…' : "Use Wise's email"}
                      </button>
                    )}
                  </td>
                </tr>
                <tr>
                  <td>Account</td>
                  <td>—</td>
                  <td>{`${wise.currency || ''} ${wise.account || ''}`.trim() || '—'}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Hubstaff (read-only) ───────────────────────────────────────── */}
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong>Hubstaff</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            {hubUserId ? `user #${hubUserId}` : 'not linked'}
          </span>
          {hubUserId != null && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={isHubLoading}
              onClick={loadHub}
            >
              {isHubLoading ? 'Loading…' : 'Refresh'}
            </button>
          )}
        </div>
        {hubErr && (
          <div className="field-err" style={{ marginTop: 6 }}>
            Hubstaff: {hubErr}
          </div>
        )}
        {hub && (
          <div className="table-scroll" style={{ marginTop: 6 }}>
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>DB</th>
                  <th>Hubstaff</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Name</td>
                  <td>{orDash(dbName)}</td>
                  <td>
                    {orDash(hub.name)}{' '}
                    {hubNameDiff && <span title="DB and external value differ">⚠️</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {hubNameDiff && (
                      <span className="muted" style={{ fontSize: 12 }}>
                        Fix in{' '}
                        <a
                          href="https://app.hubstaff.com"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Hubstaff
                        </a>
                      </span>
                    )}
                  </td>
                </tr>
                <tr>
                  <td>Email</td>
                  <td>{orDash(dbEmail)}</td>
                  <td>
                    {orDash(hub.email)}{' '}
                    {hubEmailDiff && <span title="DB and external value differ">⚠️</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {hubEmailDiff && (
                      <span className="muted" style={{ fontSize: 12 }}>
                        Fix in{' '}
                        <a
                          href="https://app.hubstaff.com"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Hubstaff
                        </a>
                      </span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Pull from Wise (only when no recipient is linked yet) ───────── */}
      {wiseId == null && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <strong>Pull from Wise</strong>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button
              type="button"
              className={lookupMode === 'id' ? 'btn sm' : 'btn ghost sm'}
              onClick={() => setMode('id')}
            >
              By recipient ID
            </button>
            <button
              type="button"
              className={lookupMode === 'tag' ? 'btn sm' : 'btn ghost sm'}
              onClick={() => setMode('tag')}
            >
              By Wisetag
            </button>
          </div>

          {lookupMode === 'id' ? (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Paste the numeric Wise recipient ID (e.g. <code>1372559053</code>) — the standard
              route for bank-account payouts.
            </p>
          ) : (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Search Wise contacts by Wisetag (with or without the @). <b>Caveat:</b> this returns
              Wise <i>contacts</i> with a <i>balance recipient ID</i> — usable only for Wise-to-Wise
              payments, not bank accounts. Most PH contractors paid via bank won't be reachable this
              way.
            </p>
          )}

          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input
              value={lookupInput}
              onChange={(e) => setLookupInput(e.target.value)}
              placeholder={
                lookupMode === 'id' ? 'numeric Wise recipient ID' : '@wisetag or wisetag'
              }
              disabled={isLookupPending}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  doLookup();
                }
              }}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn sm"
              disabled={isLookupPending || !lookupInput.trim()}
              onClick={doLookup}
            >
              {isLookupPending ? 'Looking…' : 'Look up'}
            </button>
            {(preview || results) && (
              <button type="button" className="btn ghost sm" onClick={clearLookup}>
                Clear
              </button>
            )}
          </div>

          {lookupErr && (
            <div className="field-err" style={{ marginTop: 6 }}>
              {lookupErr}
            </div>
          )}

          {results && !preview && (
            <div style={{ marginTop: 8 }}>
              <p className="muted" style={{ fontSize: 12, margin: '0 0 2px' }}>
                {results.length} contact(s) — pick one
              </p>
              <p className="muted" style={{ fontSize: 12, margin: '0 0 6px' }}>
                Wise's search is fuzzy and often returns extra results. Pick the contact that
                matches this contractor.
              </p>
              {results.map((c) => (
                <button
                  key={String(c.id)}
                  type="button"
                  className="btn ghost sm"
                  style={{ display: 'block', textAlign: 'left', width: '100%', marginTop: 4 }}
                  onClick={() => pickContact(c)}
                >
                  <b>{c.name || '(no name)'}</b>
                  {c.accountHolderName && c.accountHolderName !== c.name
                    ? ` · ${c.accountHolderName}`
                    : ''}{' '}
                  · balance recipient #{String(c.balanceRecipientId)}
                </button>
              ))}
            </div>
          )}

          {preview && (
            <div
              style={{
                marginTop: 8,
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 10,
              }}
            >
              <strong style={{ fontSize: 13 }}>
                Wise recipient #{preview.id}
                {preview.fromContact ? ' (via Wisetag — Wise-balance recipient)' : ''}
              </strong>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={applyName}
                    onChange={(e) => setApplyName(e.target.checked)}
                  />
                  <span>
                    Name: {orDash(preview.name)} <span className="muted">· Apply name to DB</span>
                  </span>
                </label>
                {preview.email != null && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={applyEmail}
                      onChange={(e) => setApplyEmail(e.target.checked)}
                    />
                    <span>
                      Email: {orDash(preview.email)}{' '}
                      <span className="muted">· Apply email to DB</span>
                    </span>
                  </label>
                )}
              </div>
              <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
                {preview.currency || '—'} · account {preview.account || '—'} ·{' '}
                {preview.active === false ? 'inactive' : 'active'}
              </p>
              <div style={{ display: 'flex', gap: 6 }}>
                {results && (
                  <button type="button" className="btn ghost sm" onClick={() => setPreview(null)}>
                    ← Back to results
                  </button>
                )}
                <button
                  type="button"
                  className="btn sm"
                  disabled={isLookupPending}
                  onClick={linkResult}
                >
                  Link recipient{applyName || applyEmail ? ' + apply selected' : ''}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {pushMsg && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {pushMsg}
        </div>
      )}
    </div>
  );
}
