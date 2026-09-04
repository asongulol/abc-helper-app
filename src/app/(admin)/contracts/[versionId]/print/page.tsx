import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ContractVersionPrint } from '@/components/print/ContractVersionPrint';
import { getCurrentAdmin } from '@/server/auth/admin';

export const metadata: Metadata = { title: 'Agreement — Aaron Anderson E.H.S. LLC' };

/** Admin print of one contract version (the profile's Contracts tab). RLS scopes the read. */
export default async function AdminContractVersionPrintPage({
  params,
}: {
  params: Promise<{ versionId: string }>;
}) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');
  const { versionId } = await params;
  return <ContractVersionPrint versionId={versionId} />;
}
