'use client';

import { Badge, type BadgeTone, Modal, useToast } from '@/components/ui';
import type { Database } from '@/db/types';
import {
  advanceFromStage1,
  completeOnboardingTab,
  finishOnboarding,
  signAgreement,
} from '@/server/actions/portal';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';

type AgreementKind = Database['public']['Enums']['agreement_kind'];
type OnboardingStage = Database['public']['Enums']['onboarding_stage'];

type OboardingProgress = {
  current_stage: OnboardingStage | null;
  stage1_complete: boolean | null;
  stage2_complete: boolean | null;
  stage3_complete: boolean | null;
  completed_at: string | null;
  stage2_last_tab: string | null;
} | null;

type Signature = {
  agreement_kind: AgreementKind;
  signed_legal_name: string | null;
  signed_date: string | null;
  status: string | null;
};

type Agreement = {
  agreement_kind: AgreementKind;
  countersigned_at: string | null;
  countersigned_name: string | null;
};

interface Props {
  workerId: string;
  progress: OboardingProgress;
  signatures: Signature[];
  agreements: Agreement[];
  templateMap: Record<string, { title: string; body: string; version: string }>;
  requiredKinds: AgreementKind[];
}

const KIND_LABEL: Record<string, string> = {
  ic_agreement: 'Independent Contractor Agreement',
  non_compete: 'Non-Compete Agreement',
  confidentiality_nda: 'Confidentiality / NDA',
  baa: 'Business Associate Agreement',
};

const STAGE_TONE: Record<string, BadgeTone> = {
  stage1_sign: 'neutral',
  stage2_profile: 'warn',
  stage3_docs: 'warn',
  complete: 'good',
};

const STAGE_LABEL: Record<string, string> = {
  stage1_sign: 'Stage 1 — Signing',
  stage2_profile: 'Stage 2 — Profile',
  stage3_docs: 'Stage 3 — Documents',
  complete: 'Complete',
};

const STAGE2_TABS = [
  { key: 'contact', label: 'Contact info' },
  { key: 'personal', label: 'Personal info' },
  { key: 'payout', label: 'Payout method' },
  { key: 'about', label: 'About you' },
];

export const PortalOnboarding = ({
  workerId: _workerId,
  progress,
  signatures,
  agreements,
  templateMap,
  requiredKinds,
}: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Stage 1 state
  const [selectedKind, setSelectedKind] = useState<AgreementKind | null>(null);
  const [typedName, setTypedName] = useState('');
  const [drawMode, setDrawMode] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [drawing, setDrawing] = useState(false);

  // Stage 2 state
  const [activeTab, setActiveTab] = useState<string | null>(null);

  const signedKinds = new Set(
    signatures.filter((s) => s.status === 'signed').map((s) => s.agreement_kind),
  );

  const currentStage = progress?.current_stage ?? 'stage1_sign';
  const isComplete = !!progress?.completed_at && currentStage === 'complete';

  // --- canvas drawing helpers ---
  const startDraw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    setDrawing(true);
    const rect = canvas.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
  };
  const continueDraw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
  };
  const endDraw = () => setDrawing(false);

  // --- touch equivalents (map touch → same draw logic) ---
  const startDrawTouch = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const touch = e.touches[0];
    if (!touch) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    setDrawing(true);
    const rect = canvas.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(touch.clientX - rect.left, touch.clientY - rect.top);
  };
  const continueDrawTouch = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!drawing) return;
    const touch = e.touches[0];
    if (!touch) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.lineTo(touch.clientX - rect.left, touch.clientY - rect.top);
    ctx.stroke();
  };
  const endDrawTouch = () => setDrawing(false);
  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  };

  const handleSign = (kind: AgreementKind) => {
    if (!typedName.trim()) {
      notify('Please type your legal name to sign.', { type: 'warn' });
      return;
    }
    let sigDataUrl = '';
    if (drawMode && canvasRef.current) {
      sigDataUrl = canvasRef.current.toDataURL('image/png');
    }
    startTransition(async () => {
      const result = await signAgreement({
        agreementKey: kind,
        signatureDataUrl: sigDataUrl,
        typedName: typedName.trim(),
      });
      if (result.ok) {
        notify(`${KIND_LABEL[kind] ?? kind} signed!`, { type: 'success' });
        setSelectedKind(null);
        setTypedName('');
        clearCanvas();
        router.refresh();
      } else {
        notify(result.error, { type: 'error' });
      }
    });
  };

  const handleAdvance = () => {
    startTransition(async () => {
      const result = await advanceFromStage1();
      if (result.ok) {
        notify('Moving to Stage 2!', { type: 'success' });
        router.refresh();
      } else {
        notify(result.error, { type: 'error' });
      }
    });
  };

  const handleTabComplete = (tab: string) => {
    startTransition(async () => {
      const result = await completeOnboardingTab({ tab });
      if (result.ok) {
        notify(result.message ?? `Tab "${tab}" marked complete.`, { type: 'success' });
        setActiveTab(null);
        router.refresh();
      } else {
        notify(result.error, { type: 'error' });
      }
    });
  };

  const handleFinish = () => {
    startTransition(async () => {
      const result = await finishOnboarding();
      if (result.ok) {
        notify('Onboarding complete! Welcome aboard.', { type: 'success' });
        router.refresh();
      } else {
        notify(result.error, { type: 'error' });
      }
    });
  };

  if (isComplete) {
    return (
      <div className="card">
        <Badge tone="good">Complete</Badge>
        <h2 style={{ marginTop: 8 }}>Onboarding complete!</h2>
        <p className="sub">All stages are done. Your documents are on file.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ margin: 0 }}>Onboarding</h2>
          <Badge tone={STAGE_TONE[currentStage] ?? 'neutral'}>
            {STAGE_LABEL[currentStage] ?? currentStage}
          </Badge>
        </div>
        <p className="sub" style={{ marginTop: 6 }}>
          Complete all three stages to finish your onboarding.
        </p>
        {/* Progress bar */}
        <div
          style={{
            height: 6,
            borderRadius: 3,
            background: 'var(--surface2)',
            marginTop: 12,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${
                progress
                  ? Math.round(
                      (((progress.stage1_complete ? 1 : 0) +
                        (progress.stage2_complete ? 1 : 0) +
                        (progress.stage3_complete ? 1 : 0)) /
                        3) *
                        100,
                    )
                  : 0
              }%`,
              height: '100%',
              background: 'var(--accent)',
              transition: 'width .4s',
            }}
          />
        </div>
      </div>

      {/* Stage 1 — Agreement signing */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Stage 1 — Sign Agreements</h3>
          {progress?.stage1_complete && <Badge tone="good">Done</Badge>}
        </div>
        <p className="sub">Sign each agreement in order.</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {requiredKinds.map((kind, idx) => {
            const isSigned = signedKinds.has(kind);
            const prevSigned =
              idx === 0 || signedKinds.has(requiredKinds[idx - 1] as AgreementKind);
            const countersig = agreements.find((a) => a.agreement_kind === kind);
            return (
              <div
                key={kind}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 12px',
                  background: 'var(--surface2)',
                  borderRadius: 6,
                }}
              >
                <div>
                  <span style={{ fontWeight: isSigned ? 600 : 400 }}>
                    {isSigned ? '✓ ' : ''}
                    {KIND_LABEL[kind] ?? kind}
                  </span>
                  {countersig?.countersigned_at && (
                    <span className="sub" style={{ fontSize: 11, marginLeft: 8 }}>
                      Countersigned by {countersig.countersigned_name ?? 'admin'}
                    </span>
                  )}
                </div>
                {!isSigned && prevSigned && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => setSelectedKind(kind)}
                    disabled={isPending}
                  >
                    Sign
                  </button>
                )}
                {!isSigned && !prevSigned && (
                  <span className="sub" style={{ fontSize: 11 }}>
                    Sign previous first
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Advance button appears when all signed but stage1 not yet set */}
        {!progress?.stage1_complete && requiredKinds.every((k) => signedKinds.has(k)) && (
          <button
            type="button"
            className="btn"
            style={{ marginTop: 12 }}
            disabled={isPending}
            onClick={handleAdvance}
          >
            {isPending ? 'Advancing…' : 'Continue to Stage 2 →'}
          </button>
        )}
      </div>

      {/* Stage 2 — Profile tabs */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Stage 2 — Complete Profile</h3>
          {progress?.stage2_complete && <Badge tone="good">Done</Badge>}
        </div>
        {!progress?.stage1_complete && <p className="sub">Finish Stage 1 first.</p>}
        {progress?.stage1_complete && (
          <>
            <p className="sub">Fill in each section then mark it complete.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              {STAGE2_TABS.map(({ key, label }) => (
                <div
                  key={key}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 12px',
                    background: 'var(--surface2)',
                    borderRadius: 6,
                  }}
                >
                  <span>{label}</span>
                  <button
                    type="button"
                    className="btn sm ghost"
                    disabled={isPending}
                    onClick={() => setActiveTab(key)}
                  >
                    Mark complete
                  </button>
                </div>
              ))}
            </div>
            <p className="sub" style={{ marginTop: 8, fontSize: 11 }}>
              Note: Go to your{' '}
              <a href="/portal/profile" style={{ textDecoration: 'underline' }}>
                Profile page
              </a>{' '}
              to fill in fields, then come back to mark each section complete.
            </p>
          </>
        )}
      </div>

      {/* Stage 3 — Documents */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Stage 3 — Documents</h3>
          {progress?.stage3_complete && <Badge tone="good">Done</Badge>}
        </div>
        {!progress?.stage2_complete && <p className="sub">Finish Stage 2 first.</p>}
        {progress?.stage2_complete && !progress.stage3_complete && (
          <>
            <p className="sub">
              Upload your required documents (resume, diploma, NBI clearance, government ID — front
              &amp; back) and wait for admin review. Once all are approved, click below.
            </p>
            <button
              type="button"
              className="btn"
              style={{ marginTop: 12 }}
              disabled={isPending}
              onClick={handleFinish}
            >
              {isPending ? 'Checking…' : 'Finish Onboarding'}
            </button>
          </>
        )}
        {progress?.stage2_complete && progress.stage3_complete && (
          <p className="sub" style={{ color: 'var(--good)' }}>
            All documents approved.
          </p>
        )}
      </div>

      {/* Signing modal */}
      {selectedKind !== null && (
        <Modal
          title={`Sign — ${KIND_LABEL[selectedKind] ?? selectedKind}`}
          onClose={() => {
            setSelectedKind(null);
            setTypedName('');
            clearCanvas();
          }}
          maxWidth={600}
        >
          {/* Agreement body — full column width preview of the contract */}
          {templateMap[selectedKind]?.body && (
            <div
              style={{
                width: '100%',
                maxHeight: 280,
                overflowY: 'auto',
                padding: '8px 12px',
                background: 'var(--surface2)',
                borderRadius: 6,
                fontSize: 13,
                whiteSpace: 'pre-wrap',
                marginBottom: 12,
              }}
            >
              {templateMap[selectedKind]?.body}
            </div>
          )}

          {/* Signature method toggle */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button
              type="button"
              className={`btn sm${!drawMode ? '' : ' ghost'}`}
              onClick={() => setDrawMode(false)}
            >
              Type signature
            </button>
            <button
              type="button"
              className={`btn sm${drawMode ? '' : ' ghost'}`}
              onClick={() => setDrawMode(true)}
            >
              Draw signature
            </button>
          </div>

          {drawMode ? (
            <>
              <canvas
                ref={canvasRef}
                width={540}
                height={120}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  cursor: 'crosshair',
                  touchAction: 'none',
                  width: '100%',
                }}
                onMouseDown={startDraw}
                onMouseMove={continueDraw}
                onMouseUp={endDraw}
                onMouseLeave={endDraw}
                onTouchStart={startDrawTouch}
                onTouchMove={continueDrawTouch}
                onTouchEnd={endDrawTouch}
              />
              <button
                type="button"
                className="btn ghost sm"
                style={{ marginTop: 6 }}
                onClick={clearCanvas}
              >
                Clear
              </button>
            </>
          ) : null}

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12 }}>
            <span className="sub" style={{ fontSize: 11 }}>
              Type your full legal name to confirm your signature
            </span>
            <input
              type="text"
              value={typedName}
              placeholder="Your legal name"
              onChange={(e) => setTypedName(e.target.value)}
            />
          </label>

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button
              type="button"
              className="btn"
              disabled={isPending || !typedName.trim()}
              onClick={() => handleSign(selectedKind)}
            >
              {isPending ? 'Signing…' : 'Sign Agreement'}
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setSelectedKind(null);
                setTypedName('');
                clearCanvas();
              }}
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {/* Tab-complete confirmation modal */}
      {activeTab !== null && (
        <Modal
          title={`Mark complete — ${STAGE2_TABS.find((t) => t.key === activeTab)?.label ?? activeTab}`}
          onClose={() => setActiveTab(null)}
          maxWidth={380}
        >
          <p>
            Make sure you have filled in all required fields on your{' '}
            <a href="/portal/profile" style={{ textDecoration: 'underline' }}>
              Profile page
            </a>{' '}
            for this section. Once marked, the system will validate the fields.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button
              type="button"
              className="btn"
              disabled={isPending}
              onClick={() => {
                const tab = activeTab;
                handleTabComplete(tab);
              }}
            >
              {isPending ? 'Saving…' : 'Mark complete'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setActiveTab(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};
