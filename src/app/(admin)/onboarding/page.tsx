import { OnboardingClient } from '@/components/onboarding/OnboardingClient';
import { createServerSupabase } from '@/db/clients/server';
import { fetchOnboardingProgress } from '@/db/queries/onboarding';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Onboarding — ABC Kids HR' };

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
  const progress = await fetchOnboardingProgress(supabase, companyId);

  return (
    <OnboardingClient
      progress={progress}
      companyId={companyId}
      canCountersign={admin.canCountersign}
    />
  );
}
