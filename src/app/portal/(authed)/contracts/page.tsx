import { redirect } from 'next/navigation';
import { PortalContracts } from '@/components/portal/PortalContracts';
import { createServerSupabase } from '@/db/clients/server';
import { fetchContractVersions } from '@/db/queries/contracts';
import { fetchOwnOnboarding } from '@/db/queries/portal';
import { getCurrentWorker } from '@/server/auth/worker';

export const metadata = { title: 'Contracts — Contractor Portal' };

/**
 * Contract history + the version awaiting signature (docs/CONTRACT-VERSIONS-PLAN.md §5).
 * Version 1 is the legacy onboarding row, read through here the way
 * contractOfRecord does it; versions 2+ come from contract_versions under RLS.
 */
export default async function PortalContractsPage() {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  const supabase = await createServerSupabase();
  const [versions, { signatures, agreements }] = await Promise.all([
    fetchContractVersions(supabase, worker.workerId),
    fetchOwnOnboarding(supabase, worker.workerId),
  ]);
  const v1 = signatures.find((s) => s.agreement_kind === 'ic_agreement' && s.doc_version === '1');
  const agreement = agreements.find((a) => a.agreement_kind === 'ic_agreement');
  const legacy = v1
    ? {
        signedAt: v1.signed_at,
        countersignedAt: agreement?.countersigned_at ?? null,
        countersignedName: agreement?.countersigned_name ?? null,
      }
    : null;

  return <PortalContracts versions={versions} legacy={legacy} />;
}
