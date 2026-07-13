import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { AutoPrint } from '@/components/print/AutoPrint';
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
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import { uuid } from '@/types/schemas/uuid';

export const metadata: Metadata = {
  title: 'Agreement — Aaron Anderson E.H.S. LLC',
};

type AgreementKind = Database['public']['Enums']['agreement_kind'];
const KINDS: AgreementKind[] = ['ic_agreement', 'non_compete', 'confidentiality_nda', 'baa'];
const KIND_LABEL: Record<string, string> = {
  ic_agreement: 'Independent Contractor Agreement',
  non_compete: 'Non-Compete Agreement',
  confidentiality_nda: 'Confidentiality / NDA',
  baa: 'Business Associate Agreement',
};

const PRE_STYLE = {
  whiteSpace: 'pre-wrap',
  fontFamily: 'Georgia, serif',
  fontSize: 14,
  lineHeight: 1.55,
  margin: 0,
} as const;

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

  const row = agreements.find((a) => a.agreementKind === agreementKind) ?? null;
  const sig =
    signatures.find((s) => s.agreementKind === agreementKind && s.status === 'signed') ?? null;
  const workerName = worker
    ? [worker.firstName, worker.middleName, worker.lastName].filter(Boolean).join(' ').trim()
    : '';

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

  return <AgreementPrint kind={agreementKind} workerName={workerName} parts={parts} />;
}

/** Shared structured render (admin + portal). Escaped labels/meta + safe <img>. */
function AgreementPrint({
  kind,
  workerName,
  parts,
}: {
  kind: AgreementKind;
  workerName: string;
  parts: ReturnType<typeof renderAgreementParts>;
}) {
  return (
    <div
      style={{
        maxWidth: 720,
        margin: '40px auto',
        padding: '0 24px',
        color: '#111',
        fontFamily: 'Georgia, serif',
        lineHeight: 1.55,
      }}
    >
      <AutoPrint />
      <h1 style={{ color: '#1F3A68', fontSize: 22, marginBottom: 4 }}>
        {KIND_LABEL[kind] ?? kind}
      </h1>
      <p style={{ color: '#677083', fontSize: 12, marginTop: 0 }}>{workerName}</p>

      <pre style={PRE_STYLE}>{parts.mergedText}</pre>

      <div style={{ marginTop: 32, display: 'flex', gap: 48, flexWrap: 'wrap' }}>
        <Signatory part={parts.contractor} />
        <Signatory part={parts.countersign} />
      </div>
    </div>
  );
}

function Signatory({ part }: { part: ReturnType<typeof renderAgreementParts>['contractor'] }) {
  return (
    <div>
      <div
        style={{
          borderBottom: '1px solid #000',
          minWidth: 240,
          minHeight: 30,
          paddingBottom: 2,
        }}
      >
        {part.imgSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          // biome-ignore lint/performance/noImgElement: print layout needs a real <img> for the signature data URL to render in PDF/print
          <img
            src={part.imgSrc}
            alt="signature"
            style={{
              height: 46,
              maxWidth: 240,
              objectFit: 'contain',
              display: 'block',
            }}
          />
        ) : part.name ? (
          <span style={{ fontFamily: 'cursive', fontSize: 18 }}>{part.name}</span>
        ) : null}
      </div>
      <div style={{ fontSize: 12, color: '#444', marginTop: 4 }}>
        <div>{part.label}</div>
        <div>{part.meta}</div>
      </div>
    </div>
  );
}
