'use client';

import {
  Badge,
  type BadgeTone,
  ConfirmDangerModal,
  EmptyState,
  Modal,
  type SortableColumn,
  SortableTable,
  useToast,
} from '@/components/ui';
import type { DocumentRow } from '@/db/queries/documents';
import { fmtDate } from '@/lib/format';
import { reviewDocument } from '@/server/actions/portal';
import { useId, useState, useTransition } from 'react';

interface Props {
  documents: DocumentRow[];
  expiringSoonCount: number;
  overdueCount: number;
  expiryWarnDays: number;
  companyId: string;
  canCountersign: boolean;
}

const KIND_LABEL: Record<string, string> = {
  ic_agreement: 'IC Agreement',
  w8ben: 'W-8BEN',
  gov_id: 'Gov ID',
  other: 'Other',
  resume: 'Resume',
  diploma: 'Diploma',
  nbi_clearance: 'NBI Clearance',
};

const REVIEW_TONE: Record<string, BadgeTone> = {
  pending: 'warn',
  approved: 'good',
  needs_replacement: 'bad',
  waived: 'neutral',
  deferred: 'neutral',
};

type KindFilter = 'all' | string;
type StatusFilter = 'all' | string;

export const DocumentsClient = ({
  documents,
  expiringSoonCount,
  overdueCount,
  expiryWarnDays,
}: Props) => {
  const idReviewNote = useId();
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();

  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedDoc, setSelectedDoc] = useState<DocumentRow | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [confirmReject, setConfirmReject] = useState(false);

  const visible = documents.filter((d) => {
    if (kindFilter !== 'all' && d.kind !== kindFilter) return false;
    if (statusFilter !== 'all' && d.reviewStatus !== statusFilter) return false;
    return true;
  });

  const handleReview = (
    doc: DocumentRow,
    decision: 'approve' | 'needs_replacement' | 'waive' | 'defer',
  ) => {
    if (decision === 'needs_replacement' && !reviewNote.trim()) {
      notify('A reason is required for needs-replacement.', { type: 'error' });
      return;
    }
    startTransition(async () => {
      const result = await reviewDocument({
        documentId: doc.id,
        decision,
        ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}),
      });
      if (result.ok) {
        notify(`Document marked as ${decision.replace('_', ' ')}.`, { type: 'success' });
        setSelectedDoc(null);
        setReviewNote('');
      } else {
        notify(result.error, { type: 'error' });
      }
    });
  };

  const columns: ReadonlyArray<SortableColumn<DocumentRow>> = [
    {
      key: 'workerName',
      label: 'Contractor',
      sortable: true,
      cardTitle: true,
    },
    {
      key: 'kind',
      label: 'Kind',
      sortable: true,
      render: (d) => KIND_LABEL[d.kind] ?? d.kind,
      accessor: (d) => d.kind,
    },
    {
      key: 'title',
      label: 'Title',
      render: (d) => d.title ?? d.side ?? '—',
    },
    {
      key: 'reviewStatus',
      label: 'Review',
      sortable: true,
      render: (d) => (
        <Badge tone={REVIEW_TONE[d.reviewStatus] ?? 'neutral'}>
          {d.reviewStatus.replace('_', ' ')}
        </Badge>
      ),
      accessor: (d) => d.reviewStatus,
    },
    {
      key: 'expiresOn',
      label: 'Expires',
      sortable: true,
      render: (d) => {
        if (!d.expiresOn) return '—';
        const exp = new Date(`${d.expiresOn}T00:00:00Z`);
        const today = new Date();
        const days = Math.round((exp.getTime() - today.getTime()) / 86_400_000);
        const isOverdue = days < 0;
        const isSoon = days >= 0 && days <= 30;
        return (
          <span style={{ color: isOverdue ? 'var(--bad)' : isSoon ? 'var(--warn)' : undefined }}>
            {fmtDate(d.expiresOn)}
          </span>
        );
      },
      accessor: (d) => d.expiresOn,
    },
    {
      key: 'createdAt',
      label: 'Uploaded',
      sortable: true,
      render: (d) => fmtDate(d.createdAt),
      accessor: (d) => d.createdAt,
    },
    {
      key: 'actions',
      label: '',
      render: (d) => (
        <button
          type="button"
          className="btn sm"
          onClick={(e) => {
            e.stopPropagation();
            setSelectedDoc(d);
            setReviewNote('');
          }}
        >
          Review
        </button>
      ),
    },
  ];

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Documents</h2>
        <p className="sub">
          All uploaded contractor documents — review, approve, or request replacement.
        </p>
      </div>

      {(overdueCount > 0 || expiringSoonCount > 0) && (
        <div
          className="card"
          style={{
            marginBottom: 16,
            background: overdueCount > 0 ? 'var(--bad-bg, #fef2f2)' : 'var(--warn-bg, #fffbeb)',
            borderLeft: `4px solid ${overdueCount > 0 ? 'var(--bad)' : 'var(--warn)'}`,
          }}
          role="alert"
        >
          <strong>
            {overdueCount > 0 && `${overdueCount} document(s) overdue. `}
            {expiringSoonCount > 0 &&
              `${expiringSoonCount} document(s) expiring within ${expiryWarnDays} days.`}
          </strong>{' '}
          Review and request replacements below.
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="sub">Kind</span>
            <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
              <option value="all">All kinds</option>
              {Object.entries(KIND_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="sub">Status</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="needs_replacement">Needs replacement</option>
              <option value="waived">Waived</option>
              <option value="deferred">Deferred</option>
            </select>
          </label>
        </div>

        <SortableTable
          columns={columns}
          rows={visible}
          rowKey={(d) => d.id}
          filterPlaceholder="Filter by contractor, kind…"
          emptyMessage={<EmptyState icon="📄" message="No documents match your filters." />}
          onRowClick={(d) => {
            setSelectedDoc(d);
            setReviewNote('');
          }}
        />
      </div>

      {selectedDoc !== null && (
        <Modal
          title={`Review: ${KIND_LABEL[selectedDoc.kind] ?? selectedDoc.kind}${selectedDoc.title ? ` — ${selectedDoc.title}` : ''}`}
          onClose={() => setSelectedDoc(null)}
          maxWidth={520}
        >
          <dl style={{ marginBottom: 12 }}>
            <dt className="sub">Contractor</dt>
            <dd>{selectedDoc.workerName}</dd>
            <dt className="sub">Uploaded</dt>
            <dd>{fmtDate(selectedDoc.createdAt)}</dd>
            {selectedDoc.expiresOn && (
              <>
                <dt className="sub">Expires</dt>
                <dd>{fmtDate(selectedDoc.expiresOn)}</dd>
              </>
            )}
            {selectedDoc.issuedOn && (
              <>
                <dt className="sub">Issued</dt>
                <dd>{fmtDate(selectedDoc.issuedOn)}</dd>
              </>
            )}
            <dt className="sub">Current status</dt>
            <dd>
              <Badge tone={REVIEW_TONE[selectedDoc.reviewStatus] ?? 'neutral'}>
                {selectedDoc.reviewStatus.replace('_', ' ')}
              </Badge>
            </dd>
            {selectedDoc.reviewReason && (
              <>
                <dt className="sub">Reason</dt>
                <dd>{selectedDoc.reviewReason}</dd>
              </>
            )}
          </dl>

          {selectedDoc.storagePath && (
            <p className="sub" style={{ marginBottom: 12 }}>
              Storage path: <code>{selectedDoc.storagePath}</code>
            </p>
          )}

          <label className="sub" htmlFor={idReviewNote}>
            Note / reason (required for &ldquo;Needs replacement&rdquo;)
          </label>
          <textarea
            id={idReviewNote}
            value={reviewNote}
            onChange={(e) => setReviewNote(e.target.value)}
            rows={2}
            style={{ width: '100%', marginBottom: 10 }}
            placeholder="Reason for rejection or optional approval note…"
          />

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              disabled={isPending}
              onClick={() => handleReview(selectedDoc, 'approve')}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn warn"
              disabled={isPending}
              onClick={() => setConfirmReject(true)}
            >
              Needs replacement
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={isPending}
              onClick={() => handleReview(selectedDoc, 'waive')}
            >
              Waive
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={isPending}
              onClick={() => handleReview(selectedDoc, 'defer')}
            >
              Defer
            </button>
          </div>
        </Modal>
      )}

      {confirmReject && selectedDoc !== null && (
        <ConfirmDangerModal
          title="Request replacement"
          message={`Request a replacement for this ${KIND_LABEL[selectedDoc.kind] ?? selectedDoc.kind} from ${selectedDoc.workerName}?${reviewNote.trim() ? ` Reason: "${reviewNote.trim()}"` : ' (Add a reason above.)'}`}
          confirmLabel="Request replacement"
          onConfirm={() => {
            setConfirmReject(false);
            handleReview(selectedDoc, 'needs_replacement');
          }}
          onCancel={() => setConfirmReject(false)}
        />
      )}
    </>
  );
};
