'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
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
    <Modal title="Documents to upload" maxWidth={560} onClose={dismiss}>
      <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 2 }}>
        <span aria-hidden="true">📄</span> {slots.length} document
        {slots.length > 1 ? 's' : ''} to upload
      </div>
      <p className="sub" style={{ marginTop: 0 }}>
        Please upload these so HR can finish your file.
      </p>
      <div>
        {slots.map((s) => (
          <UploadSlot key={`${s.kind}|${s.side ?? ''}`} slot={s} onUploaded={reload} />
        ))}
      </div>
      <div className="actions">
        <button type="button" className="btn ghost" onClick={dismiss}>
          Later
        </button>
      </div>
    </Modal>
  );
};
