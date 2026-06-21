import { notFound } from 'next/navigation';
import { ProfileModalRoute } from '@/components/contractors/profile/ProfileModalRoute';
import { loadContractor } from '../../loadContractor';

/**
 * Intercept route: on soft navigation to `/contractors/[workerId]`, render the
 * profile as an overlay modal over the roster. `(.)` intercepts the sibling
 * `[workerId]` segment; hard navigation bypasses this and loads the full page.
 */
export default async function ContractorModalIntercept({
  params,
}: {
  params: Promise<{ workerId: string }>;
}) {
  const { workerId } = await params;
  const data = await loadContractor(workerId);
  if (!data) notFound();

  return (
    <ProfileModalRoute
      worker={data.worker}
      companyId={data.companyId}
      companyName={data.companyName}
      companies={data.companies}
    />
  );
}
