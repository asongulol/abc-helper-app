import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { AGREEMENT_TITLE, AgreementPrint } from '@/components/print/AgreementPrint';
import { createServerSupabase } from '@/db/clients/server';
import { fetchAgreements, fetchSignatures } from '@/db/queries/onboarding';
import { fetchAgreementTemplate } from '@/db/queries/portal';
import { fetchWorkerLink } from '@/db/queries/workers';
import type { Database } from '@/db/types';
import {
  type AgreementVars,
  monthlyFromPeriod,
  renderAgreementParts,
} from '@/lib/agreements/merge';
import { fullName } from '@/lib/names';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import { uuid } from '@/types/schemas/uuid';

export const metadata: Metadata = {
  title: 'Agreement — Aaron Anderson E.H.S. LLC',
};

type AgreementKind = Database['public']['Enums']['agreement_kind'];
const KINDS: AgreementKind[] = ['ic_agreement', 'non_compete', 'confidentiality_nda', 'baa'];
export default async function AdminAgreementPrintPage({
  params,
}: {
  params: Promise<{ workerId: string; kind: string }>;
}) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const { workerId, kind } = await params;
  if (!uuid().safeParse(workerId).success) notFound();
  if (!KINDS.includes(kind as AgreementKind)) notFound();
  const agreementKind = kind as AgreementKind;

  const companyId = await getSelectedCompanyId();
  if (!companyId) notFound();

  const supabase = await createServerSupabase();
  const [template, agreements, signatures, worker] = await Promise.all([
    fetchAgreementTemplate(supabase, agreementKind),
    fetchAgreements(supabase, workerId),
    fetchSignatures(supabase, workerId),
    fetchWorkerLink(supabase, workerId, companyId),
  ]);
  if (!template) notFound();
  // A well-formed but nonexistent workerId used to render a blank agreement and
  // auto-print it; 404 instead (#040).
  if (!worker) notFound();

  const row = agreements.find((a) => a.agreementKind === agreementKind) ?? null;
  const sig =
    signatures.find((s) => s.agreementKind === agreementKind && s.status === 'signed') ?? null;
  const workerName = fullName(worker);

  const vars: AgreementVars = {
    contractor_name: workerName,
    rate: row?.fRate ?? undefined,
    monthly_rate: monthlyFromPeriod(row?.fRate),
    company_name: row?.fCompanyName ?? undefined,
    start_date: row?.fStartDate ?? worker?.hireDate ?? undefined,
    position: row?.fPosition ?? undefined,
    countersigner_name: row?.countersignerName ?? undefined,
    contractor_address: worker?.phAddress ?? undefined,
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
