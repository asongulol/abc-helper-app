'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui';
import type { RosterWorker } from '@/db/queries/workers';
import { ProfileTabs } from './profile/ProfileTabs';
import { useContractorProfile } from './profile/useContractorProfile';

type Props = {
  worker: RosterWorker;
  companyId: string;
  companyName?: string | undefined;
  /** All companies (employer + clients) for the engagements assign-to select. */
  companies?: { id: string; name: string }[] | undefined;
  onSaved: (updated: RosterWorker) => void;
};

/**
 * Contractor profile as an overlay modal — mounted by the intercept route
 * (`@modal/(.)[workerId]`) on soft navigation. Hard navigation renders
 * `ContractorProfilePage` instead. Both share `useContractorProfile`.
 */
export function ProfilePanel({ worker, companyId, companyName, companies = [], onSaved }: Props) {
  const p = useContractorProfile(worker, companyId, { onSaved });
  const [pendingClose, setPendingClose] = useState(false);

  // Reflect current dirtiness into the popstate handler without re-binding it.
  const dirtyRef = useRef(p.dirty);
  dirtyRef.current = p.dirty;
  const closingRef = useRef(false);
  const armedRef = useRef(false);

  // Close the intercept modal. We arm one extra ("sentinel") history entry (see
  // the effect) so a browser Back is caught while the modal stays mounted, so
  // unwinding pops TWO entries (sentinel + the modal route) back to the list.
  const closeModal = useCallback(() => {
    closingRef.current = true;
    window.history.go(-2);
  }, []);

  const guardedClose = () => {
    if (p.dirty) setPendingClose(true);
    else closeModal();
  };

  // Guard the browser/OS Back button. App Router unmounts the intercept modal on
  // popstate without routing through guardedClose, so edits vanish silently
  // (#018). Arm a sentinel so the first Back lands on it (modal still mounted),
  // then surface the same unsaved-changes prompt the ×/Esc/backdrop paths use.
  useEffect(() => {
    if (!armedRef.current) {
      window.history.pushState(null, '', window.location.href);
      armedRef.current = true;
    }
    const onPop = () => {
      if (closingRef.current) {
        closingRef.current = false;
        return; // our own closeModal() — let Next render the list
      }
      window.history.pushState(null, '', window.location.href); // re-arm
      if (dirtyRef.current) setPendingClose(true);
      else closeModal();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [closeModal]);

  return (
    <Modal title={p.fullName || 'New contractor'} onClose={guardedClose} maxWidth={720}>
      <p className="sub" style={{ margin: '0 0 12px' }}>
        {companyName ? `${companyName} · ` : ''}
        {worker.linkStatus}
      </p>

      <ProfileTabs
        p={p}
        worker={worker}
        companyId={companyId}
        companyName={companyName}
        companies={companies}
      />

      {pendingClose && (
        <Modal title="Unsaved changes" onClose={() => setPendingClose(false)} maxWidth={440}>
          <p className="sub" style={{ marginBottom: 14 }}>
            You have unsaved changes in this contractor's profile. Save them before leaving, or
            discard them?
          </p>
          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => setPendingClose(false)}>
              Stay on page
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                setPendingClose(false);
                closeModal();
              }}
            >
              Discard changes
            </button>
            <button
              type="button"
              className="btn"
              disabled={p.isPending}
              onClick={() => {
                setPendingClose(false);
                p.doSave();
              }}
            >
              Save
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
