'use client';

import { useEffect, useState } from 'react';
import { fetchOutstandingDocSlots, type OutstandingDocSlot } from '@/server/actions/portal-docs';
import { UploadSlot } from './PortalDocs';

interface Props {
  /** Titles of required documents the contractor still needs to upload. Drives
   *  whether the reminder shows; the full per-slot uploaders are fetched here. */
  docs: string[];
}

const DISMISS_KEY = 'abc_doc_reminder_dismissed';

/**
 * Forced "Documents to upload" reminder (portal, manifest 01 — legacy
 * `DocReminder` modal variant, portal/index.html ~1966-1985). Shows once per
 * browser session when the contractor still owes required onboarding documents,
 * and renders an UploadSlot PER outstanding document so they can upload right in
 * the overlay. "Later" dismisses for the session.
 */
export const DocReminderOverlay = ({ docs }: Props) => {
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<OutstandingDocSlot[]>([]);

  useEffect(() => {
    if (docs.length === 0) return;
    const dismissed = sessionStorage.getItem(DISMISS_KEY) === '1';
    if (dismissed) return;
    let active = true;
    fetchOutstandingDocSlots().then((s) => {
      if (active && s.length > 0) {
        setSlots(s);
        setOpen(true);
      }
    });
    return () => {
      active = false;
    };
  }, [docs.length]);

  if (!open || slots.length === 0) return null;

  const dismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, '1');
    setOpen(false);
  };

  const reload = () => {
    fetchOutstandingDocSlots().then((s) => {
      setSlots(s);
      if (s.length === 0) setOpen(false);
    });
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close; "Later" button also closes.
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Documents to upload"
      onClick={dismiss}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,28,51,.55)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        zIndex: 60,
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops backdrop close only. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: sheet panel only stops backdrop-close propagation; it exposes no action and adds no keyboard semantics. */}
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 560,
          width: '100%',
          margin: 0,
          borderRadius: '16px 16px 0 0',
          maxHeight: '86vh',
          overflowY: 'auto',
          borderTop: '4px solid var(--gold)',
        }}
      >
        <div
          className="row"
          style={{
            padding: 0,
            marginBottom: 4,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <b>Documents to upload</b>
          <button
            type="button"
            className="btn ghost"
            style={{ padding: '4px 10px', fontSize: 13 }}
            onClick={dismiss}
          >
            Later
          </button>
        </div>
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 2 }}>
          📄 {slots.length} document{slots.length > 1 ? 's' : ''} to upload
        </div>
        <p className="sub" style={{ marginTop: 0 }}>
          Please upload these so HR can finish your file.
        </p>
        <div>
          {slots.map((s) => (
            <UploadSlot key={`${s.kind}|${s.side ?? ''}`} slot={s} onUploaded={reload} />
          ))}
        </div>
      </div>
    </div>
  );
};
