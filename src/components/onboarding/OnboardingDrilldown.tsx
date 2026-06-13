'use client';

import { Badge, Modal, useToast } from '@/components/ui';
import type { OnboardingProgressRow } from '@/db/queries/onboarding';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { deriveStageInfo } from '@/lib/onboarding/progress';
import { countersignAgreement } from '@/server/actions/portal';
import { useState, useTransition } from 'react';

interface Props {
  row: OnboardingProgressRow;
  canCountersign: boolean;
  onClose: () => void;
}

const AGREEMENT_LABELS: Record<string, string> = {
  ic_agreement: 'IC Agreement',
  non_compete: 'Non-Compete',
  confidentiality_nda: 'Confidentiality NDA',
  baa: 'BAA',
};

export const OnboardingDrilldown = ({ row, canCountersign, onClose }: Props) => {
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();
  const [countersignModal, setCountersignModal] = useState<string | null>(null);
  const [signatureInput, setSignatureInput] = useState('');

  const info = deriveStageInfo({
    stage1Complete: row.stage1Complete,
    stage2Complete: row.stage2Complete,
    stage3Complete: row.stage3Complete,
    completedAt: row.completedAt,
    currentStage: row.currentStage,
    nameMismatchFlag: row.nameMismatchFlag,
    stalled: row.stalled,
  });

  const handleCountersign = (agreementKey: string) => {
    if (!signatureInput.trim()) {
      notify('Signature required.', { type: 'error' });
      return;
    }
    startTransition(async () => {
      const result = await countersignAgreement({
        workerId: row.workerId,
        agreementKey,
        signatureDataUrl: signatureInput.trim(),
      });
      if (result.ok) {
        notify('Agreement countersigned.', { type: 'success' });
        setCountersignModal(null);
        setSignatureInput('');
      } else {
        notify(result.error, { type: 'error' });
      }
    });
  };

  const _STAGE_ORDER = ['stage1_sign', 'stage2_profile', 'stage3_docs', 'complete'];
  const stages = [
    { key: 'stage1_sign', label: 'Stage 1 — Sign agreements', done: row.stage1Complete },
    { key: 'stage2_profile', label: 'Stage 2 — Complete profile', done: row.stage2Complete },
    { key: 'stage3_docs', label: 'Stage 3 — Upload documents', done: row.stage3Complete },
  ];

  const agreements = ['ic_agreement', 'non_compete', 'confidentiality_nda', 'baa'] as const;

  return (
    <Modal title={`Onboarding — ${row.workerName}`} onClose={onClose} maxWidth={580}>
      <div style={{ marginBottom: 12 }}>
        <Badge tone={info.tone}>{info.label}</Badge>
        {row.nameMismatchFlag && (
          <Badge tone="warn" style={{ marginLeft: 6 }}>
            Name mismatch
          </Badge>
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
        <p className="sub" style={{ marginBottom: 4 }}>
          Started: {fmtDate(row.startedAt)}
          {row.completedAt && ` · Completed: ${fmtDateTime(row.completedAt)}`}
        </p>
      </div>

      {/* Progress bar */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            height: 6,
            background: 'var(--border)',
            borderRadius: 4,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${info.pct}%`,
              background: info.tone === 'good' ? 'var(--good)' : 'var(--accent)',
              borderRadius: 4,
              transition: 'width 0.3s',
            }}
          />
        </div>
        <p className="sub" style={{ marginTop: 4 }}>
          {info.pct}% complete
        </p>
      </div>

      {/* Stage checklist */}
      <div style={{ marginBottom: 16 }}>
        {stages.map((stage) => (
          <div
            key={stage.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 0',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: stage.done ? 'var(--good)' : 'var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                color: stage.done ? '#fff' : undefined,
                flexShrink: 0,
              }}
              aria-hidden="true"
            >
              {stage.done ? '✓' : ''}
            </span>
            <span style={{ flex: 1 }}>{stage.label}</span>
            {stage.key === 'stage1_sign' && row.stage1LastKind && (
              <span className="sub">
                Last: {AGREEMENT_LABELS[row.stage1LastKind] ?? row.stage1LastKind}
              </span>
            )}
            {stage.key === 'stage2_profile' && row.stage2LastTab && (
              <span className="sub">Last tab: {row.stage2LastTab}</span>
            )}
          </div>
        ))}
      </div>

      {/* Countersign section */}
      {canCountersign && row.stage1Complete && (
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>Countersign agreements</h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {agreements.map((kind) => (
              <button
                key={kind}
                type="button"
                className="btn sm"
                disabled={isPending}
                onClick={() => {
                  setCountersignModal(kind);
                  setSignatureInput('');
                }}
              >
                {AGREEMENT_LABELS[kind]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="btn ghost" onClick={onClose}>
          Close
        </button>
      </div>

      {countersignModal !== null && (
        <Modal
          title={`Countersign — ${AGREEMENT_LABELS[countersignModal] ?? countersignModal}`}
          onClose={() => setCountersignModal(null)}
          maxWidth={400}
        >
          <p className="sub" style={{ marginBottom: 10 }}>
            Enter your full legal name or paste a drawn-signature data URL.
          </p>
          <textarea
            value={signatureInput}
            onChange={(e) => setSignatureInput(e.target.value)}
            rows={3}
            style={{ width: '100%', marginBottom: 12 }}
            placeholder="Full legal name or data:image/... URI"
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={isPending}
              onClick={() => handleCountersign(countersignModal)}
            >
              {isPending ? 'Signing…' : 'Countersign'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setCountersignModal(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
};
