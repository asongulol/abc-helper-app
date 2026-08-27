'use client';

import { useId, useState } from 'react';
import { Modal } from './Modal';

export interface ConfirmDangerModalProps {
  // Optional props accept an explicit `undefined` (exactOptionalPropertyTypes)
  // so callers can pass conditionally-computed strings without a spread dance.
  title?: string | undefined;
  /** Plain-language description of what is about to happen. */
  message?: string | undefined;
  /** Consequence callout (rendered as a warning banner), e.g. "This cannot be undone." */
  consequence?: string | undefined;
  /** When set, the user must type this word (case-insensitive) to enable Confirm. */
  confirmWord?: string | undefined;
  /** When set, the user must write a reason, handed to onConfirm. For actions
   *  that erase the only record of a decision — the reason becomes that record. */
  reasonLabel?: string | undefined;
  reasonPlaceholder?: string | undefined;
  confirmLabel?: string | undefined;
  /** Disables both buttons while the confirmed action runs. */
  busy?: boolean | undefined;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/**
 * Risk-proportional confirm dialog — port of the legacy `confirmDanger` /
 * <DangerConfirm/> pattern: title + message + consequence banner, and for
 * irreversible actions a type-the-word gate (LOCK / DELETE / entity name).
 */
export const ConfirmDangerModal = ({
  title = 'Please confirm',
  message,
  consequence,
  confirmWord,
  reasonLabel,
  reasonPlaceholder,
  confirmLabel = 'Confirm',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDangerModalProps) => {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const inputId = useId();
  const reasonId = useId();
  const needWord = Boolean(confirmWord);
  const ready =
    (!needWord || typed.trim().toLowerCase() === String(confirmWord).trim().toLowerCase()) &&
    (!reasonLabel || reason.trim().length >= 3);
  const confirm = () => onConfirm(reason.trim());

  return (
    <Modal title={title} onClose={onCancel} maxWidth={460}>
      {message != null && (
        <p
          className="sub"
          style={{
            marginBottom: consequence ? 10 : 14,
            whiteSpace: 'pre-wrap',
          }}
        >
          {message}
        </p>
      )}
      {consequence != null && (
        <div className="banner" style={{ marginBottom: 14, whiteSpace: 'pre-wrap' }}>
          {consequence}
        </div>
      )}
      {needWord && (
        <div className="field" style={{ marginBottom: 4 }}>
          <label htmlFor={inputId}>
            TYPE <b>{String(confirmWord).toUpperCase()}</b> TO CONFIRM
          </label>
          <input
            id={inputId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready && !busy) confirm();
            }}
            aria-label={`Type ${confirmWord} to confirm`}
          />
        </div>
      )}
      {reasonLabel && (
        <div className="field" style={{ marginBottom: 4 }}>
          <label htmlFor={reasonId}>{reasonLabel}</label>
          <input
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reasonPlaceholder}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready && !busy) confirm();
            }}
          />
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn danger" disabled={!ready || busy} onClick={confirm}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
};
