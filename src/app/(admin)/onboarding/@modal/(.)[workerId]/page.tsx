import { notFound } from 'next/navigation';
import { OnboardingModalRoute } from '@/components/onboarding/OnboardingModalRoute';
import { loadOnboarding } from '../../loadOnboarding';

/**
 * Intercept route: on soft navigation to `/onboarding/[workerId]`, render the
 * review as an overlay modal over the list. `(.)` intercepts the sibling
 * `[workerId]` segment; hard navigation bypasses this and loads the full page.
 */
export default async function OnboardingModalIntercept({
  params,
}: {
  params: Promise<{ workerId: string }>;
}) {
  const { workerId } = await params;
  const data = await loadOnboarding(workerId);
  if (!data) notFound();

  return (
    <OnboardingModalRoute
      row={data.row}
      canCountersign={data.canCountersign}
      isOwner={data.isOwner}
    />
  );
}
