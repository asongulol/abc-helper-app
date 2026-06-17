import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { OnboardingClient } from '@/components/onboarding/OnboardingClient';
import { createServerSupabase } from '@/db/clients/server';
import { getEmployer, listAgreementTemplates } from '@/db/queries/config';
import { fetchOnboardingProgress } from '@/db/queries/onboarding';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';

export const metadata: Metadata = {
  title: 'Onboarding — Aaron Anderson E.H.S. LLC',
};

export default async function OnboardingPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Onboarding</h2>
        <p className="sub">No company selected. Please contact the owner.</p>
      </div>
    );
  }

  const supabase = await createServerSupabase();
  // `progress` is the core data and gates the page; `templates`/`employer` only
  // feed the optional "Agreement templates" modal, so keep them non-fatal — a
  // transient error there must not take down the whole onboarding screen.
  const [progress, templates, employer] = await Promise.all([
    fetchOnboardingProgress(supabase, companyId),
    listAgreementTemplates(supabase).catch(() => []),
    getEmployer(supabase).catch(() => null),
  ]);

  return (
    <OnboardingClient
      progress={progress}
      companyId={companyId}
      canCountersign={admin.canCountersign}
      isOwner={admin.isOwner}
      templates={templates}
      employerName={employer?.name ?? 'Aaron Anderson E.H.S. LLC'}
    />
  );
}
