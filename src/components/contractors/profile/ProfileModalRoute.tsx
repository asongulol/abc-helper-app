'use client';

import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui';
import type { RosterWorker } from '@/db/queries/workers';
import { ProfilePanel } from '../ProfilePanel';

interface Props {
  worker: RosterWorker;
  companyId: string;
  companyName?: string | undefined;
  companies?: { id: string; name: string }[] | undefined;
  isOwner: boolean;
}

/**
 * Client wrapper for the intercept route's modal: supplies save revalidation.
 * ProfilePanel owns close (it unwinds its own Back-guard history entry back to
 * `/contractors`); saving refreshes so the underlying list reflects edits.
 */
export function ProfileModalRoute({ worker, companyId, companyName, companies, isOwner }: Props) {
  const router = useRouter();
  const { notify } = useToast();

  return (
    <ProfilePanel
      worker={worker}
      companyId={companyId}
      companyName={companyName}
      companies={companies}
      isOwner={isOwner}
      onSaved={(_updated: RosterWorker) => {
        notify('Saved.', { type: 'success' });
        router.refresh();
      }}
    />
  );
}
