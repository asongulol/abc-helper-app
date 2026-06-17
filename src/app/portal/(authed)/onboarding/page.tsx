import { redirect } from 'next/navigation';
import { PortalOnboarding } from '@/components/portal/PortalOnboarding';
import { createServerSupabase } from '@/db/clients/server';
import { fetchAgreements } from '@/db/queries/onboarding';
import { fetchAgreementTemplate, fetchOwnOnboarding, fetchOwnProfile } from '@/db/queries/portal';
import type { Database } from '@/db/types';
import { type AgreementVars, mergeAgreement, monthlyFromPeriod } from '@/lib/agreements/merge';
import { getCurrentWorker } from '@/server/auth/worker';

type AgreementKind = Database['public']['Enums']['agreement_kind'];

const REQUIRED_KINDS: AgreementKind[] = [
  'ic_agreement',
  'non_compete',
  'confidentiality_nda',
  'baa',
];

export default async function PortalOnboardingPage() {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  const supabase = await createServerSupabase();
  // prefill (per-kind onboarding_agreements) + profile drive the merge, so the
  // contractor signs the FILLED contract — the same vars the print route uses.
  const [{ progress, signatures, agreements }, prefill, profile, templates] = await Promise.all([
    fetchOwnOnboarding(supabase, worker.workerId),
    fetchAgreements(supabase, worker.workerId),
    fetchOwnProfile(supabase, worker.workerId),
    Promise.all(REQUIRED_KINDS.map((kind) => fetchAgreementTemplate(supabase, kind))),
  ]);

  const workerName = profile
    ? [profile.first_name, profile.middle_name, profile.last_name].filter(Boolean).join(' ').trim()
    : `${worker.firstName} ${worker.lastName}`.trim();
  const today = new Date().toISOString().slice(0, 10);

  const templateMap: Record<string, { title: string; body: string; version: string }> = {};
  for (const t of templates) {
    if (!t?.kind) continue;
    const row = prefill.find((a) => a.agreementKind === t.kind) ?? null;
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
      today,
    };
    templateMap[t.kind] = {
      title: t.title ?? t.kind,
      // Merge here so the signing modal shows the filled contract, not raw {{tokens}}.
      body: mergeAgreement(t.body ?? '', vars),
      version: t.version ?? '1',
    };
  }

  return (
    <PortalOnboarding
      workerId={worker.workerId}
      progress={progress}
      signatures={signatures}
      agreements={agreements}
      templateMap={templateMap}
      requiredKinds={REQUIRED_KINDS}
    />
  );
}
