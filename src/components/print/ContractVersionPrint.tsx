import { notFound } from 'next/navigation';
import { AGREEMENT_TITLE, AgreementPrint } from '@/components/print/AgreementPrint';
import { createServerSupabase } from '@/db/clients/server';
import { fetchContractVersion } from '@/db/queries/contracts';
import { fetchSignatures } from '@/db/queries/onboarding';
import { renderAgreementParts } from '@/lib/agreements/merge';
import { fullName } from '@/lib/names';
import { uuid } from '@/types/schemas/uuid';

/**
 * A contract version as it was signed: the body frozen at send, never the live
 * template (docs/CONTRACT-VERSIONS-PLAN.md §5). Reads on the caller's RLS
 * client, so a contractor sees only their own versions and an admin only the
 * workers they can see — the route just authenticates and hands over the id.
 * 404 for anything without a frozen body (a draft has nothing to print).
 */
export async function ContractVersionPrint({ versionId }: { versionId: string }) {
  if (!uuid().safeParse(versionId).success) notFound();
  const db = await createServerSupabase();
  const v = await fetchContractVersion(db, versionId);
  if (!v?.renderedBody) notFound();

  const [signatures, { data: w }] = await Promise.all([
    fetchSignatures(db, v.workerId),
    db
      .from('workers')
      .select('first_name, middle_name, last_name')
      .eq('id', v.workerId)
      .maybeSingle(),
  ]);
  const workerName = w
    ? fullName({ firstName: w.first_name, middleName: w.middle_name, lastName: w.last_name })
    : '';
  const sig =
    signatures.find(
      (s) =>
        s.agreementKind === 'ic_agreement' &&
        s.docVersion === String(v.version) &&
        s.status === 'signed',
    ) ?? null;

  // No vars: the merge has nothing to substitute or append, so the frozen
  // text passes through byte-for-byte — the same text the signature's sha256 names.
  const parts = renderAgreementParts({
    body: v.renderedBody,
    contractorName: workerName,
    signature: sig,
    countersign: v.countersignedAt
      ? {
          countersignedAt: v.countersignedAt,
          countersignedName: v.countersignedName,
          countersignerName: v.countersignedName,
        }
      : null,
  });

  return (
    <AgreementPrint
      title={`${AGREEMENT_TITLE.ic_agreement} — version ${v.version}`}
      workerName={workerName}
      parts={parts}
    />
  );
}
