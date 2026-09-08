import { redirect } from 'next/navigation';
import { PortalContracts, type PortalPackage } from '@/components/portal/PortalContracts';
import { createServerSupabase } from '@/db/clients/server';
import { fetchContractVersions, isLegacySignatureVersion } from '@/db/queries/contracts';
import { fetchAgreements } from '@/db/queries/onboarding';
import {
  fetchAgreementTemplate,
  fetchOwnDocuments,
  fetchOwnOnboarding,
  fetchOwnProfile,
} from '@/db/queries/portal';
import { mergeAgreement, monthlyFromPeriod } from '@/lib/agreements/merge';
import { PACKAGE_TITLE, packageStatusOf } from '@/lib/contracts/package';
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
  const [allVersions, { signatures, agreements }, documents, prefill, profile] = await Promise.all([
    fetchContractVersions(supabase, worker.workerId),
    fetchOwnOnboarding(supabase, worker.workerId),
    fetchOwnDocuments(supabase, worker.workerId),
    fetchAgreements(supabase, worker.workerId),
    fetchOwnProfile(supabase, worker.workerId),
  ]);
  // The change note is the admin's; the contractor gets the reason label only
  // (docs/CONTRACT-CHANGE-WIZARD-PLAN.md decision 2) — stripped here so it never
  // reaches the browser.
  const versions = allVersions.map(({ changeNote: _note, ...v }) => v);
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

  // The re-sign package (wizard decision 8): the newest version that asked for
  // one, judged on the signatures still `signed`. The contractor signs the
  // filled agreement, merged the way the onboarding page merges it.
  const status = packageStatusOf(allVersions, new Set(signatures.map((s) => s.agreement_kind)));
  let pkg: PortalPackage | null = null;
  if (status && status.outstanding.length > 0) {
    const workerName = profile
      ? [profile.first_name, profile.middle_name, profile.last_name]
          .filter(Boolean)
          .join(' ')
          .trim()
      : `${worker.firstName} ${worker.lastName}`.trim();
    const today = new Date().toISOString().slice(0, 10);
    const templates = await Promise.all(
      status.outstanding.map((kind) => fetchAgreementTemplate(supabase, kind)),
    );
    pkg = {
      dueOn: status.dueOn,
      contractSigned: status.contractSigned,
      items: status.kinds.map((kind) => {
        const t = templates.find((x) => x?.kind === kind);
        const row = prefill.find((a) => a.agreementKind === kind) ?? null;
        return {
          kind,
          title: PACKAGE_TITLE[kind],
          signed: !status.outstanding.includes(kind),
          body: t
            ? mergeAgreement(t.body ?? '', {
                contractor_name: workerName,
                rate: row?.fRate ?? undefined,
                monthly_rate: monthlyFromPeriod(row?.fRate),
                company_name: row?.fCompanyName ?? undefined,
                start_date: row?.fStartDate ?? profile?.hire_date ?? undefined,
                position: row?.fPosition ?? undefined,
                countersigner_name: row?.countersignerName ?? undefined,
                contractor_address: profile?.ph_address ?? undefined,
                employment_type: row?.fEmploymentType ?? undefined,
                hours_per_week: row?.fHoursPerWeek ?? undefined,
                schedule: row?.fSchedule ?? undefined,
                today,
              })
            : '',
        };
      }),
    };
  }

  return (
    <PortalContracts
      versions={versions}
      legacy={legacy}
      agreements={signedAgreements}
      uploads={uploads}
      pkg={pkg}
    />
  );
}
