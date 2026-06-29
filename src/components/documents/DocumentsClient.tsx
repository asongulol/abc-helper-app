'use client';

import { useId, useState, useTransition } from 'react';
import { useToast } from '@/components/ui';
import type { DocumentRow } from '@/db/queries/documents';
import type { Database } from '@/db/types';
import { addDocument } from '@/server/actions/documents-admin';

type DocumentKind = Database['public']['Enums']['document_kind'];

interface WorkerOption {
  id: string;
  name: string;
}

interface Props {
  documents: DocumentRow[];
  workerOptions: WorkerOption[];
  companyId: string;
  consolidated: boolean;
}

/** Type options shown in the add row — verbatim from legacy DOC_KINDS. */
const DOC_KINDS: ReadonlyArray<readonly [DocumentKind, string]> = [
  ['ic_agreement', 'IC Agreement'],
  ['w8ben', 'W-8BEN'],
  ['gov_id', 'Gov ID'],
  ['other', 'Other'],
];

/** Whole days from today until `dateStr` (null when absent) — legacy daysUntil. */
const daysUntil = (dateStr: string | null): number | null => {
  if (!dateStr) return null;
  const target = new Date(`${dateStr}T00:00:00`);
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00`);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
};

export const DocumentsClient = ({ documents, workerOptions, companyId, consolidated }: Props) => {
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();

  const idContractor = useId();
  const idType = useId();
  const idTitle = useId();
  const idSigned = useId();
  const idExpires = useId();

  const [form, setForm] = useState({
    worker_id: '',
    kind: 'ic_agreement' as DocumentKind,
    title: '',
    signed_on: '',
    expires_on: '',
  });

  const nameById = new Map(workerOptions.map((w) => [w.id, w.name]));

  // Legacy orders by expires_on ascending, nulls last.
  const list = [...documents].sort((a, b) => {
    if (a.expiresOn === b.expiresOn) return 0;
    if (!a.expiresOn) return 1;
    if (!b.expiresOn) return -1;
    return a.expiresOn < b.expiresOn ? -1 : 1;
  });

  const addDoc = () => {
    if (!form.worker_id) {
      notify('Pick a contractor.', { type: 'error' });
      return;
    }
    startTransition(async () => {
      const result = await addDocument({
        companyId,
        workerId: form.worker_id,
        kind: form.kind,
        title: form.title,
        signedOn: form.signed_on,
        expiresOn: form.expires_on,
      });
      if (result.ok) {
        setForm({
          worker_id: '',
          kind: 'ic_agreement',
          title: '',
          signed_on: '',
          expires_on: '',
        });
      } else {
        notify(result.error, { type: 'error' });
      }
    });
  };

  return (
    <div>
      <div className="card">
        <h2>Documents</h2>
        <p className="sub">
          Track each contractor&apos;s IC agreement, W-8BEN, and IDs. Set an expiry to get a
          reminder here when it&apos;s within 30 days (or overdue).
        </p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field">
            <label htmlFor={idContractor}>Contractor</label>
            <select
              id={idContractor}
              value={form.worker_id}
              onChange={(e) => setForm({ ...form, worker_id: e.target.value })}
            >
              <option value="">Select…</option>
              {workerOptions.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={idType}>Type</label>
            <select
              id={idType}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as DocumentKind })}
            >
              {DOC_KINDS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={idTitle}>Title (optional)</label>
            <input
              id={idTitle}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. 2026 IC Agreement"
            />
          </div>
          <div className="field">
            <label htmlFor={idSigned}>Signed</label>
            <input
              id={idSigned}
              type="date"
              value={form.signed_on}
              onChange={(e) => setForm({ ...form, signed_on: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={idExpires}>Expires</label>
            <input
              id={idExpires}
              type="date"
              value={form.expires_on}
              onChange={(e) => setForm({ ...form, expires_on: e.target.value })}
            />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button type="button" className="btn" disabled={isPending} onClick={addDoc}>
              Add document
            </button>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          File upload to secure storage is a Phase-2 add-on (needs the Storage bucket from setup).
          For now this tracks the record + dates.
        </p>
      </div>

      <div className="card">
        <h2>Tracked documents {consolidated ? '· all companies' : ''}</h2>
        {list.length === 0 ? (
          <div className="empty">No documents yet. Add one above.</div>
        ) : (
          <div className="table-scroll">
            <table aria-label="Tracked documents">
              <thead>
                <tr>
                  <th scope="col">Contractor</th>
                  <th scope="col">Type</th>
                  <th scope="col">Title</th>
                  <th scope="col">Signed</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((d) => {
                  const n = daysUntil(d.expiresOn);
                  const overdue = n != null && n < 0;
                  const soon = n != null && n >= 0 && n <= 30;
                  return (
                    <tr
                      key={d.id}
                      style={
                        overdue
                          ? { background: 'var(--bad-soft)' }
                          : soon
                            ? { background: 'var(--warn-soft)' }
                            : {}
                      }
                    >
                      <td className="card-title">
                        <b>{nameById.get(d.workerId) ?? '—'}</b>
                      </td>
                      <td data-label="Type">
                        {DOC_KINDS.find((k) => k[0] === d.kind)?.[1] ?? d.kind}
                      </td>
                      <td data-label="Title">{d.title || '—'}</td>
                      <td data-label="Signed">{d.signedOn || '—'}</td>
                      <td data-label="Expires">
                        {d.expiresOn || <span className="muted">no expiry</span>}
                      </td>
                      <td data-label="Status">
                        {n == null ? (
                          <span className="muted">—</span>
                        ) : overdue ? (
                          <span className="pill bad">overdue {Math.abs(n)}d</span>
                        ) : soon ? (
                          <span className="pill warn">in {n}d</span>
                        ) : (
                          <span className="pill active">ok</span>
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
    </div>
  );
};
