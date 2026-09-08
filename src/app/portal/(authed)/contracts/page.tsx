import { redirect } from 'next/navigation';
import { PortalContracts } from '@/components/portal/PortalContracts';
import { createServerSupabase } from '@/db/clients/server';
import { fetchContractVersions, isLegacySignatureVersion } from '@/db/queries/contracts';
import { fetchOwnDocuments, fetchOwnOnboarding } from '@/db/queries/portal';
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
  const [versions, { signatures, agreements }, documents] = await Promise.all([
    fetchContractVersions(supabase, worker.workerId),
    fetchOwnOnboarding(supabase, worker.workerId),
    fetchOwnDocuments(supabase, worker.workerId),
  ]);
  // A signed copy uploaded as a file (Docs tab kind "IC Agreement") is an agreement too.
  const uploads = documents
    .filter((d) => d.kind === 'ic_agreement' && d.storagePath)
    .map((d) => ({ id: d.id, title: d.title, signedOn: d.signedOn, createdAt: d.createdAt }));
  const v1 = signatures.find(
    (s) => s.agreement_kind === 'ic_agreement' && isLegacySignatureVersion(s.doc_version),
  );
  const agreement = agreements.find((a) => a.agreement_kind === 'ic_agreement');
  const legacy = v1
    ? {
        signedAt: v1.signed_at,
        countersignedAt: agreement?.countersigned_at ?? null,
        countersignedName: agreement?.countersigned_name ?? null,
      }
    : null;

  // The NDA / non-compete / BAA live only on the Onboarding tab, which hides once
  // onboarding completes — surface the signed ones here so the contractor can
  // always print their own copy. Signatures are newest-first; keep one per kind.
  const signedAgreements = signatures
    .filter((s) => s.agreement_kind !== 'ic_agreement')
    .filter((s, i, all) => all.findIndex((x) => x.agreement_kind === s.agreement_kind) === i)
    .map((s) => {
      const a = agreements.find((x) => x.agreement_kind === s.agreement_kind);
      return {
        kind: s.agreement_kind,
        signedAt: s.signed_at,
        countersignedAt: a?.countersigned_at ?? null,
        countersignedName: a?.countersigned_name ?? null,
      };
    });

  return (
    <PortalContracts
      versions={versions}
      legacy={legacy}
      agreements={signedAgreements}
      uploads={uploads}
    />
  );
}
