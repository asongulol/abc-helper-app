import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ContractVersionPrint } from '@/components/print/ContractVersionPrint';
import { getCurrentWorker } from '@/server/auth/worker';

export const metadata: Metadata = { title: 'Agreement — Aaron Anderson E.H.S. LLC' };

/** The contractor's copy of one contract version — the frozen body, not the live template. */
export default async function PortalContractVersionPrintPage({
  params,
}: {
  params: Promise<{ versionId: string }>;
}) {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');
  const { versionId } = await params;
  return <ContractVersionPrint versionId={versionId} />;
}
