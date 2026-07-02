'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui';
import { getAdminDocumentUrl } from '@/server/actions/portal';

export type DocReviewDecision = 'approve' | 'needs_replacement' | 'waive' | 'defer';

interface Props {
  documentId: string;
  /** Modal title — caller-computed (slot label / file name / kind label). */
  name: string;
  /** Null → fileless placeholder: a "no file" note is shown instead of a preview. */
  storagePath: string | null;
  busy: boolean;
  /**
   * Emits the decision only — the caller owns the follow-ups (reason modal for
   * needs_replacement, waive confirm) and closing this modal.
   */
  onDecision: (decision: DocReviewDecision) => void;
  onClose: () => void;
}

const DECISIONS: ReadonlyArray<readonly [DocReviewDecision, string]> = [
  ['approve', 'Approve'],
  ['needs_replacement', 'Needs replacement'],
  ['waive', 'Waive'],
  ['defer', 'Defer'],
];

/**
 * Shared admin document review modal — signed-URL preview (image / pdf /
 * other) with the four review decisions inside it. Used by the onboarding
 * drilldown's Documents section and the contractor ProfilePanel Documents tab.
 */
export const DocReviewModal = ({
  documentId,
  name,
  storagePath,
  busy,
  onDecision,
  onClose,
}: Props) => {
  const [preview, setPreview] = useState<{
    url: string;
    type: 'image' | 'pdf' | 'other';
  } | null>(null);
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    if (!storagePath) return;
    let live = true;
    getAdminDocumentUrl({ documentId }).then((res) => {
      if (!live) return;
      if (res.ok) setPreview({ url: res.data.url, type: res.data.type });
      else setPreviewError(res.error);
    });
    return () => {
      live = false;
    };
  }, [documentId, storagePath]);

  return (
    <Modal title={name} onClose={onClose} maxWidth={920}>
      {!storagePath ? (
        <p className="sub">No file uploaded for this document.</p>
      ) : previewError ? (
        <p style={{ color: 'var(--bad)', fontSize: 13 }} role="alert">
          {previewError}
        </p>
      ) : !preview ? (
        <p className="sub">Loading preview…</p>
      ) : preview.type === 'image' ? (
        // biome-ignore lint/performance/noImgElement: remote Supabase signed-URL document preview, not a static asset
        <img
          src={preview.url}
          alt={name}
          style={{
            display: 'block',
            maxWidth: '100%',
            maxHeight: '72vh',
            margin: '0 auto',
            objectFit: 'contain',
          }}
        />
      ) : preview.type === 'pdf' ? (
        <iframe
          src={preview.url}
          title={name}
          style={{
            width: '100%',
            height: '72vh',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        />
      ) : (
        <p className="sub">This file type can’t be previewed inline — open it in a new tab.</p>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {DECISIONS.map(([decision, label]) => (
          <button
            key={decision}
            type="button"
            className="btn ghost sm"
            disabled={busy}
            onClick={() => onDecision(decision)}
          >
            {label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {preview && (
          <a href={preview.url} target="_blank" rel="noopener noreferrer" className="btn ghost sm">
            Open in new tab ↗
          </a>
        )}
        <button type="button" className="btn ghost sm" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
};
