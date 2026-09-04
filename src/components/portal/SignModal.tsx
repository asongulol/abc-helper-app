'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui';

/** What a signature submission carries — the e-sign evidence the actions record. */
export type SignInput = { signatureDataUrl: string; typedName: string; scrolledToEnd: boolean };

interface Props {
  title: string;
  /** The filled agreement text — what the signer is agreeing to. */
  body: string;
  busy: boolean;
  onClose: () => void;
  onSign: (sig: SignInput) => void;
}

/**
 * The scroll-to-end + type-or-draw signing modal, shared by stage-1 onboarding
 * and contract versions. State lives here and resets on unmount; the parent
 * owns the server action and closes the modal on success.
 */
export const SignModal = ({ title, body, busy, onClose, onSign }: Props) => {
  const [typedName, setTypedName] = useState('');
  const [drawMode, setDrawMode] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const agreementRef = useRef<HTMLElement | null>(null);
  // E-sign evidence: the signer must scroll through the full agreement before the
  // Sign button enables. If the body fits without scrolling there's nothing to
  // gate on, so it counts as read.
  const [scrolledEnd, setScrolledEnd] = useState(false);
  useEffect(() => {
    const el = agreementRef.current;
    setScrolledEnd(!el || el.scrollHeight <= el.clientHeight + 4);
  }, []);
  const onAgreementScroll = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setScrolledEnd(true);
  };
  const [drawing, setDrawing] = useState(false);

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

  const submit = () => {
    const name = typedName.trim();
    if (!name) return;
    const signatureDataUrl =
      drawMode && canvasRef.current ? canvasRef.current.toDataURL('image/png') : '';
    onSign({ signatureDataUrl, typedName: name, scrolledToEnd: scrolledEnd });
  };

  return (
    <Modal title={title} onClose={onClose} maxWidth={600}>
      {/* Agreement body — full column width preview of the contract.
          Scrollable region kept keyboard-focusable so non-mouse users can
          scroll it (WCAG 2.1.1); a labelled <section> is a region landmark. */}
      {body && (
        <section
          ref={agreementRef}
          onScroll={onAgreementScroll}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable scroll region (WCAG 2.1.1).
          tabIndex={0}
          aria-label="Agreement text — scroll to the end to enable signing"
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
          {body}
        </section>
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
            role="img"
            aria-label="Signature drawing area — draw your signature with mouse or finger"
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

      <label
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          marginTop: 12,
        }}
      >
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

      {!scrolledEnd && (
        <p className="sub" style={{ fontSize: 11, marginTop: 12, color: 'var(--warn, #b45309)' }}>
          Scroll through the full agreement to enable signing.
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button
          type="button"
          className="btn"
          disabled={busy || !typedName.trim() || !scrolledEnd}
          onClick={submit}
        >
          {busy ? 'Signing…' : 'Sign Agreement'}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
};
