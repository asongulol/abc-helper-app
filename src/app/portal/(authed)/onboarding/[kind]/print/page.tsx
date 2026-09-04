import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { AGREEMENT_TITLE, AgreementPrint } from '@/components/print/AgreementPrint';
import { createServerSupabase } from '@/db/clients/server';
import { fetchAgreements, fetchSignatures } from '@/db/queries/onboarding';
import { fetchAgreementTemplate, fetchOwnProfile } from '@/db/queries/portal';
import type { Database } from '@/db/types';
import {
  type AgreementVars,
  monthlyFromPeriod,
  renderAgreementParts,
} from '@/lib/agreements/merge';
import { getCurrentWorker } from '@/server/auth/worker';

export const metadata: Metadata = {
  title: 'Agreement — Aaron Anderson E.H.S. LLC',
};

type AgreementKind = Database['public']['Enums']['agreement_kind'];
const KINDS: AgreementKind[] = ['ic_agreement', 'non_compete', 'confidentiality_nda', 'baa'];
export default async function PortalAgreementPrintPage({
  params,
}: {
  params: Promise<{ kind: string }>;
}) {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  const { kind } = await params;
  if (!KINDS.includes(kind as AgreementKind)) notFound();
  const agreementKind = kind as AgreementKind;

  const supabase = await createServerSupabase();
  const [template, agreements, signatures, profile] = await Promise.all([
    fetchAgreementTemplate(supabase, agreementKind),
    fetchAgreements(supabase, worker.workerId),
    fetchSignatures(supabase, worker.workerId),
    fetchOwnProfile(supabase, worker.workerId),
  ]);
  if (!template) notFound();

  const row = agreements.find((a) => a.agreementKind === agreementKind) ?? null;
  const sig =
    signatures.find((s) => s.agreementKind === agreementKind && s.status === 'signed') ?? null;
  // The contractor may only print an agreement they have actually signed.
  if (!sig) notFound();

  const workerName = profile
    ? [profile.first_name, profile.middle_name, profile.last_name].filter(Boolean).join(' ').trim()
    : `${worker.firstName} ${worker.lastName}`.trim();

  const vars: AgreementVars = {
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
    today: new Date().toISOString().slice(0, 10),
  };

  const parts = renderAgreementParts({
    body: template.body,
    vars,
    contractorName: workerName,
    signature: sig,
    countersign: row,
  });

  return (
    <AgreementPrint
      title={AGREEMENT_TITLE[agreementKind] ?? agreementKind}
      workerName={workerName}
      parts={parts}
    />
  );
}
