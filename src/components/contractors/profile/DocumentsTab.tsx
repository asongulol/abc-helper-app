'use client';

import { useEffect, useState, useTransition } from 'react';
import { DocReviewModal } from '@/components/documents/DocReviewModal';
import { Badge, type BadgeTone, ConfirmDangerModal, Modal, useToast } from '@/components/ui';
import type { WorkerDocumentRow } from '@/db/queries/documents';
import type { RosterWorker } from '@/db/queries/workers';
import type { Database } from '@/db/types';
import { fmtDate } from '@/lib/format';
import { deleteContractorDocument, reviewDocument } from '@/server/actions/portal';
import { listContractorDocuments, uploadDocumentForContractor } from '@/server/actions/portal-docs';

type DocumentKind = Database['public']['Enums']['document_kind'];

interface Props {
  worker: RosterWorker;
  /** Spread of the shell's tablist.panelProps() — makes this div the active tabpanel. */
  panelProps: { role: 'tabpanel'; id: string; 'aria-labelledby': string; tabIndex: number };
}

const KIND_LABELS: ReadonlyArray<readonly [DocumentKind, string]> = [
  ['ic_agreement', 'IC Agreement'],
  ['w8ben', 'W-8BEN'],
  ['gov_id', 'Government-issued ID'],
  ['resume', 'Resume / CV'],
  ['diploma', 'Diploma or Transcript of Records'],
  ['nbi_clearance', 'NBI Clearance'],
  ['other', 'Other'],
];

const statusTone = (s: WorkerDocumentRow['reviewStatus']): BadgeTone =>
  s === 'approved' || s === 'waived' ? 'good' : s === 'needs_replacement' ? 'bad' : 'neutral';

const docName = (d: WorkerDocumentRow, label: string) =>
  d.title ?? d.storagePath?.split('/').pop() ?? label;

/**
 * Admin per-contractor document manager: full upload history grouped by kind
 * (newest first), additive uploads of any kind, review via the shared
 * DocReviewModal, and permanent delete.
 */
export function DocumentsTab({ worker, panelProps }: Props) {
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();

  const [docs, setDocs] = useState<WorkerDocumentRow[] | null>(null);
  const [reviewDoc, setReviewDoc] = useState<WorkerDocumentRow | null>(null);
  const [reason, setReason] = useState<{ documentId: string; text: string } | null>(null);
  const [waiveConfirm, setWaiveConfirm] = useState<{ documentId: string; name: string } | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<WorkerDocumentRow | null>(null);

  // Upload form
  const [upKind, setUpKind] = useState<DocumentKind>('resume');
  const [upSide, setUpSide] = useState('front');
  const [upIssuedOn, setUpIssuedOn] = useState('');
  const [upFile, setUpFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  const loadDocs = () => {
    listContractorDocuments({ workerId: worker.workerId }).then((res) => {
      if (res.ok) setDocs(res.data.documents);
      else notify(res.error, { type: 'error' });
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per worker on mount.
  useEffect(() => {
    loadDocs();
  }, [worker.workerId]);

  const handleUpload = () => {
    if (!upFile) return;
    const form = new FormData();
    form.set('workerId', worker.workerId);
    form.set('file', upFile);
    form.set('kind', upKind);
    if (upKind === 'gov_id') form.set('side', upSide);
    if (upKind === 'nbi_clearance') form.set('issuedOn', upIssuedOn);
    startTransition(async () => {
      const res = await uploadDocumentForContractor(form);
      if (res.ok) {
        notify('Uploaded — pending review.', { type: 'success' });
        setUpFile(null);
        setFileInputKey((k) => k + 1);
        loadDocs();
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };

  const runReview = (
    documentId: string,
    decision: 'approve' | 'needs_replacement' | 'waive' | 'defer',
    reasonText?: string,
  ) => {
    startTransition(async () => {
      const res = await reviewDocument({
        documentId,
        decision,
        ...(reasonText ? { note: reasonText } : {}),
      });
      if (res.ok) {
        notify('Document updated.', { type: 'success' });
        setReason(null);
        loadDocs();
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };

  const handleDecision = (
    d: WorkerDocumentRow,
    decision: 'approve' | 'needs_replacement' | 'waive' | 'defer',
    label: string,
  ) => {
    setReviewDoc(null);
    if (decision === 'needs_replacement') setReason({ documentId: d.id, text: '' });
    else if (decision === 'waive') setWaiveConfirm({ documentId: d.id, name: docName(d, label) });
    else runReview(d.id, decision);
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    startTransition(async () => {
      const res = await deleteContractorDocument({ documentId: deleteTarget.id });
      if (res.ok) {
        notify('Document deleted.', { type: 'success' });
        setDeleteTarget(null);
        loadDocs();
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };

  const kindLabel = (kind: DocumentKind) => KIND_LABELS.find(([k]) => k === kind)?.[1] ?? kind;

  return (
    <div {...panelProps}>
      {/* Upload — always additive: a new pending row every time, history kept. */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          paddingBottom: 10,
          borderBottom: '1px solid var(--border)',
          marginBottom: 10,
        }}
      >
        <div className="field">
          <label htmlFor="doc-up-kind">Type</label>
          <select
            id="doc-up-kind"
            value={upKind}
            onChange={(e) => setUpKind(e.target.value as DocumentKind)}
            style={{ padding: '4px 6px', fontSize: 13 }}
          >
            {KIND_LABELS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {upKind === 'gov_id' && (
          <div className="field">
            <label htmlFor="doc-up-side">Side</label>
            <select
              id="doc-up-side"
              value={upSide}
              onChange={(e) => setUpSide(e.target.value)}
              style={{ padding: '4px 6px', fontSize: 13 }}
            >
              <option value="front">Front</option>
              <option value="back">Back</option>
            </select>
          </div>
        )}
        {upKind === 'nbi_clearance' && (
          <div className="field">
            <label htmlFor="doc-up-issued">Date issued</label>
            <input
              id="doc-up-issued"
              type="date"
              value={upIssuedOn}
              onChange={(e) => setUpIssuedOn(e.target.value)}
              style={{ padding: '4px 6px', fontSize: 13 }}
            />
          </div>
        )}
        <div className="field" style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="doc-up-file">File (PDF, JPG or PNG · max 10 MB)</label>
          <input
            key={fileInputKey}
            id="doc-up-file"
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            onChange={(e) => setUpFile(e.target.files?.[0] ?? null)}
            style={{ fontSize: 12 }}
          />
        </div>
        <button
          type="button"
          className="btn sm"
          disabled={isPending || !upFile || (upKind === 'nbi_clearance' && !upIssuedOn)}
          onClick={handleUpload}
        >
          {isPending ? 'Uploading…' : 'Upload'}
        </button>
      </div>

      {docs === null ? (
        <p className="sub">Loading documents…</p>
      ) : docs.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No documents yet — upload one above, or the contractor can upload from the portal.
        </p>
      ) : (
        KIND_LABELS.map(([kind, label]) => {
          const group = docs.filter((d) => d.kind === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind} style={{ marginBottom: 10 }}>
              <span className="section-label">{label}</span>
              {group.map((d) => (
                <div
                  key={d.id}
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    padding: '6px 0',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <span style={{ minWidth: 86, fontSize: 13 }}>{fmtDate(d.createdAt)}</span>
                  <span className="muted" style={{ flex: 1, minWidth: 160, fontSize: 13 }}>
                    {docName(d, label)}
                    {d.side ? ` (${d.side})` : ''}
                    {d.issuedOn ? ` · issued ${fmtDate(d.issuedOn)}` : ''}
                  </span>
                  <Badge tone={statusTone(d.reviewStatus)}>
                    {d.reviewStatus.replace('_', ' ')}
                    {d.reviewStatus === 'deferred' && d.expiresOn
                      ? ` → ${fmtDate(d.expiresOn)}`
                      : ''}
                  </Badge>
                  {d.storagePath && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={isPending}
                      onClick={() => setReviewDoc(d)}
                    >
                      Review
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={isPending}
                    onClick={() => setDeleteTarget(d)}
                    style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          );
        })
      )}

      {reviewDoc && (
        <DocReviewModal
          documentId={reviewDoc.id}
          name={docName(reviewDoc, kindLabel(reviewDoc.kind))}
          storagePath={reviewDoc.storagePath}
          busy={isPending}
          onDecision={(decision) => handleDecision(reviewDoc, decision, kindLabel(reviewDoc.kind))}
          onClose={() => setReviewDoc(null)}
        />
      )}

      {reason && (
        <Modal title="Needs replacement — reason" onClose={() => setReason(null)} maxWidth={480}>
          <p className="sub">
            The contractor sees this note in their portal next to the re-upload slot.
          </p>
          <div className="field">
            <label htmlFor="doc-reason">Reason</label>
            <input
              id="doc-reason"
              type="text"
              value={reason.text}
              onChange={(e) => setReason({ ...reason, text: e.target.value })}
              placeholder="e.g. Photo is blurry — please re-scan"
              style={{ width: '100%', padding: '4px 6px', fontSize: 13 }}
            />
          </div>
          <div className="actions" style={{ gap: 8 }}>
            <button type="button" className="btn ghost" onClick={() => setReason(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              disabled={isPending || !reason.text.trim()}
              onClick={() => runReview(reason.documentId, 'needs_replacement', reason.text.trim())}
            >
              {isPending ? 'Saving…' : 'Send back'}
            </button>
          </div>
        </Modal>
      )}

      {waiveConfirm && (
        <ConfirmDangerModal
          title="Waive this document?"
          message={`Waive “${waiveConfirm.name}”? The contractor won't be required to provide it.`}
          consequence="Reversible — re-decide the document to require it again."
          confirmLabel="Waive"
          busy={isPending}
          onConfirm={() => {
            const target = waiveConfirm;
            setWaiveConfirm(null);
            runReview(target.documentId, 'waive');
          }}
          onCancel={() => setWaiveConfirm(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmDangerModal
          title="Delete document?"
          message={`Permanently delete “${docName(deleteTarget, kindLabel(deleteTarget.kind))}” (${fmtDate(deleteTarget.createdAt)})?`}
          consequence="The file is permanently removed. If this was the approved copy of a required document, the onboarding checklist reverts to the previous upload (or Missing). Cannot be undone."
          confirmLabel="Delete"
          busy={isPending}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
