'use client';

import { useState } from 'react';
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
  onClose: () => void;
  onSaved: (updated: RosterWorker) => void;
};

/**
 * Contractor profile as an overlay modal — mounted by the intercept route
 * (`@modal/(.)[workerId]`) on soft navigation. Hard navigation renders
 * `ContractorProfilePage` instead. Both share `useContractorProfile`.
 */
export function ProfilePanel({
  worker,
  companyId,
  companyName,
  companies = [],
  onClose,
  onSaved,
}: Props) {
  const p = useContractorProfile(worker, companyId, { onSaved });
  const [pendingClose, setPendingClose] = useState(false);

  const guardedClose = () => {
    if (p.dirty) setPendingClose(true);
    else onClose();
  };

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
                onClose();
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
