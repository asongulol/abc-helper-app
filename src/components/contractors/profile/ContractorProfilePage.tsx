'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui';
import type { RosterWorker } from '@/db/queries/workers';
import { ProfileTabs } from './ProfileTabs';
import { useContractorProfile } from './useContractorProfile';

interface Props {
  worker: RosterWorker;
  companyId: string;
  companyName?: string | undefined;
  companies?: { id: string; name: string }[] | undefined;
}

/**
 * Contractor profile as a full page — rendered on hard navigation / deep-link
 * to `/contractors/[workerId]`. Soft navigation from the list shows the overlay
 * modal (`ProfilePanel`) instead. Both share `useContractorProfile`; saves
 * revalidate the list via `router.refresh()`. The unsaved-guard (inside the
 * hook) protects navigation away from this page.
 */
export function ContractorProfilePage({ worker, companyId, companyName, companies = [] }: Props) {
  const router = useRouter();
  const { notify } = useToast();
  const p = useContractorProfile(worker, companyId, {
    onSaved: () => {
      notify('Saved.', { type: 'success' });
      router.refresh();
    },
  });

  return (
    <div className="card">
      <div className="actionbar">
        <div>
          <Link href="/contractors" className="btn ghost sm" style={{ marginBottom: 8 }}>
            ← Contractors
          </Link>
          <h2 style={{ margin: '4px 0 0' }}>{p.fullName || 'New contractor'}</h2>
          <p className="sub" style={{ margin: '4px 0 0' }}>
            {companyName ? `${companyName} · ` : ''}
            {worker.linkStatus}
          </p>
        </div>
      </div>

      <ProfileTabs
        p={p}
        worker={worker}
        companyId={companyId}
        companyName={companyName}
        companies={companies}
      />
    </div>
  );
}
