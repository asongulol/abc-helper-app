import { PortalOnboarding } from '@/components/portal/PortalOnboarding';
import { createServerSupabase } from '@/db/clients/server';
import { fetchAgreementTemplate, fetchOwnOnboarding } from '@/db/queries/portal';
import type { Database } from '@/db/types';
import { getCurrentWorker } from '@/server/auth/worker';
import { redirect } from 'next/navigation';

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
  const { progress, signatures, agreements } = await fetchOwnOnboarding(supabase, worker.workerId);

  // Pre-fetch templates for all required agreements
  const templates = await Promise.all(
    REQUIRED_KINDS.map((kind) => fetchAgreementTemplate(supabase, kind)),
  );

  const templateMap: Record<string, { title: string; body: string; version: string }> = {};
  for (const t of templates) {
    if (t?.kind) {
      templateMap[t.kind] = {
        title: t.title ?? t.kind,
        body: t.body ?? '',
        version: t.version ?? '1',
      };
    }
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
