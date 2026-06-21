'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { OnboardingProgressRow } from '@/db/queries/onboarding';
import { OnboardingDetailBody } from './OnboardingDetailBody';

interface Props {
  row: OnboardingProgressRow;
  canCountersign: boolean;
  isOwner: boolean;
}

/**
 * Onboarding review as a full page — rendered on hard navigation / deep-link to
 * `/onboarding/[workerId]`. Soft navigation from the list shows the overlay
 * modal (`OnboardingDrilldown`). Both share `OnboardingDetailBody`. A
 * destructive action (delete / withdraw) returns to the list.
 */
export const OnboardingDetailPage = ({ row, canCountersign, isOwner }: Props) => {
  const router = useRouter();
  return (
    <div className="card">
      <div style={{ marginBottom: 16 }}>
        <Link href="/onboarding" className="btn ghost sm" style={{ marginBottom: 8 }}>
          ← Hiring &amp; Onboarding
        </Link>
        <h2 style={{ margin: '4px 0 0' }}>Onboarding — {row.workerName}</h2>
      </div>
      <OnboardingDetailBody
        row={row}
        canCountersign={canCountersign}
        isOwner={isOwner}
        onClose={() => router.push('/onboarding')}
      />
    </div>
  );
};
