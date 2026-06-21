import { notFound } from 'next/navigation';
import { ContractorProfilePage } from '@/components/contractors/profile/ContractorProfilePage';
import { loadContractor } from '../loadContractor';

export const metadata = { title: 'Contractor — Aaron Anderson E.H.S. LLC' };

/**
 * Full-page contractor profile (hard navigation / deep-link). Soft navigation
 * from the roster shows the intercept modal instead.
 */
export default async function ContractorDetailPage({
  params,
}: {
  params: Promise<{ workerId: string }>;
}) {
  const { workerId } = await params;
  const data = await loadContractor(workerId);
  if (!data) notFound();

  return (
    <ContractorProfilePage
      worker={data.worker}
      companyId={data.companyId}
      companyName={data.companyName}
      companies={data.companies}
    />
  );
}
