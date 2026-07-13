'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { useToast } from '@/components/ui';
import type { PortalDocumentRow } from '@/db/queries/portal';
import { getDocumentSignedUrl } from '@/server/actions/portal';
import { type OutstandingDocSlot, uploadOwnDocument } from '@/server/actions/portal-docs';

/** Document "Type" choices for the free-form "Upload a document" card. */
const DOC_TYPES = [
  { value: 'ic_agreement', label: 'IC Agreement' },
  { value: 'w8ben', label: 'W-8BEN' },
  { value: 'gov_id', label: 'Government ID' },
] as const;

const KIND_LABELS: Record<string, string> = {
  ic_agreement: 'IC Agreement',
  w8ben: 'W-8BEN',
  gov_id: 'Government ID',
};
const labelKind = (k: string) => KIND_LABELS[k] ?? k;

/**
 * One outstanding required-document uploader (legacy `UploadSlot`,
 * portal/index.html ~1966-1990): bold doc-title label, an optional "Date issued"
 * date input (NBI only), a native file input ("Choose File"), and an inline
 * "Upload" button. Reused by the Docs tab and the login DocReminderOverlay.
 */
export const UploadSlot = ({
  slot,
  onUploaded,
}: {
  slot: OutstandingDocSlot;
  onUploaded?: () => void;
}) => {
  const { notify } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [issued, setIssued] = useState('');
  const [busy, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const isNbi = slot.kind === 'nbi_clearance';

  const upload = () => {
    if (!file) {
      notify('Choose a file first.', { type: 'error' });
      return;
    }
    startTransition(async () => {
      const form = new FormData();
      form.set('file', file);
      form.set('kind', slot.kind);
      if (slot.side) form.set('side', slot.side);
      if (isNbi) form.set('issuedOn', issued);
      const res = await uploadOwnDocument(form);
      if (res.ok) {
        notify('Uploaded — pending review.', { type: 'success' });
        setFile(null);
        setIssued('');
        if (inputRef.current) inputRef.current.value = '';
        onUploaded?.();
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };

  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
      <div style={{ fontWeight: 700 }}>{slot.label}</div>
      {isNbi && (
        <label style={{ display: 'block' }}>
          <span className="sub" style={{ display: 'block', marginTop: 6 }}>
            Date issued
          </span>
          <input type="date" value={issued} onChange={(e) => setIssued(e.target.value)} />
        </label>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/jpeg,image/png"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        style={{ margin: '6px 0' }}
      />
      <div>
        <button
          type="button"
          className="btn ghost"
          style={{
            color: 'var(--accent)',
            borderColor: 'var(--accent)',
            padding: '6px 12px',
          }}
          disabled={busy}
          onClick={upload}
        >
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </div>
  );
};

export const PortalDocs = ({
  documents,
  outstanding,
}: {
  documents: PortalDocumentRow[];
  outstanding: OutstandingDocSlot[];
}) => {
  const { notify } = useToast();
  const router = useRouter();
  const [kind, setKind] = useState<string>('ic_agreement');
  const [file, setFile] = useState<File | null>(null);
  const [busy, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = () => router.refresh();

  const view = (id: string) => {
    // Open synchronously on the click so user-activation is still live when the
    // tab navigates — opening after the `await` below left it stuck on about:blank.
    const win = window.open('', '_blank');
    if (win) win.opener = null; // 'noopener' hygiene without the feature string (which makes window.open return null)
    startTransition(async () => {
      const res = await getDocumentSignedUrl({ documentId: id });
      if (res.ok) {
        if (win) win.location.href = res.data.url;
        else window.open(res.data.url, '_blank');
      } else {
        win?.close();
        notify(res.error, { type: 'error' });
      }
    });
  };

  const upload = () => {
    if (!file) {
      notify('Choose a file first.', { type: 'error' });
      return;
    }
    startTransition(async () => {
      const form = new FormData();
      form.set('file', file);
      form.set('kind', kind);
      const res = await uploadOwnDocument(form);
      if (res.ok) {
        notify('Uploaded ✓', { type: 'success' });
        setFile(null);
        if (inputRef.current) inputRef.current.value = '';
        refresh();
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>📄 Documents</h2>
      </div>

      {outstanding.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 2 }}>
            📄 {outstanding.length} document{outstanding.length > 1 ? 's' : ''} to upload
          </div>
          <p className="sub" style={{ marginTop: 0 }}>
            Please upload these so HR can finish your file.
          </p>
          <div>
            {outstanding.map((s) => (
              <UploadSlot key={`${s.kind}|${s.side ?? ''}`} slot={s} onUploaded={refresh} />
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Upload a document</div>
        <label>
          <span className="sub">Type</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            style={{
              width: '100%',
              padding: 12,
              fontSize: 16,
              border: '1px solid var(--line)',
              borderRadius: 10,
              margin: '6px 0',
            }}
          >
            {DOC_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="filedrop" style={{ margin: '8px 0' }}>
          {file ? (
            <span style={{ color: 'var(--text)', fontWeight: 600 }}>📎 {file.name}</span>
          ) : (
            <span>Tap to choose a file — PDF, JPG or PNG</span>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <button
          type="button"
          className="btn"
          style={{ width: '100%' }}
          disabled={busy}
          onClick={upload}
        >
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </div>

      {documents.length === 0 ? (
        <div className="card">
          <p className="sub">No documents on file yet.</p>
        </div>
      ) : (
        documents.map((d) => (
          <div className="card" key={d.id} style={{ marginBottom: 16 }}>
            <div className="docrow">
              <span className="docicon">📄</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{labelKind(d.kind)}</div>
                {d.title && (
                  <div
                    className="sub"
                    style={{
                      margin: 0,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {d.title}
                  </div>
                )}
              </div>
              {d.storagePath && (
                <button
                  type="button"
                  className="btn link"
                  style={{ padding: '4px 8px' }}
                  disabled={busy}
                  onClick={() => view(d.id)}
                >
                  View
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </>
  );
};
