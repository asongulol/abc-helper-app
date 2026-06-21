'use client';

import { useRouter } from 'next/navigation';
import type { OnboardingProgressRow } from '@/db/queries/onboarding';
import { OnboardingDrilldown } from './OnboardingDrilldown';

interface Props {
  row: OnboardingProgressRow;
  canCountersign: boolean;
  isOwner: boolean;
}

/**
 * Client wrapper for the intercept route's modal: closing returns to the list
 * via `router.back()`. Onboarding actions revalidate themselves (the body calls
 * `router.refresh()` after each), so no extra wiring is needed here.
 */
export const OnboardingModalRoute = ({ row, canCountersign, isOwner }: Props) => {
  const router = useRouter();
  return (
    <OnboardingDrilldown
      row={row}
      canCountersign={canCountersign}
      isOwner={isOwner}
      onClose={() => router.back()}
    />
  );
};
