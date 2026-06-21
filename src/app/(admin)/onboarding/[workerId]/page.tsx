import { notFound } from 'next/navigation';
import { OnboardingDetailPage } from '@/components/onboarding/OnboardingDetailPage';
import { loadOnboarding } from '../loadOnboarding';

export const metadata = { title: 'Onboarding — Aaron Anderson E.H.S. LLC' };

/**
 * Full-page onboarding review (hard navigation / deep-link). Soft navigation
 * from the list shows the intercept modal instead.
 */
export default async function OnboardingDetailRoute({
  params,
}: {
  params: Promise<{ workerId: string }>;
}) {
  const { workerId } = await params;
  const data = await loadOnboarding(workerId);
  if (!data) notFound();

  return (
    <OnboardingDetailPage
      row={data.row}
      canCountersign={data.canCountersign}
      isOwner={data.isOwner}
    />
  );
}
