import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { OnboardingClient } from '@/components/onboarding/OnboardingClient';
import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import { listAdmins } from '@/db/queries/admins';
import { getEmployer } from '@/db/queries/config';
import { fetchOnboardingFollowups, fetchOnboardingProgress } from '@/db/queries/onboarding';
import { fetchWorkerIdsForClients } from '@/db/queries/workers';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedClientIds, getSelectedCompanyId } from '@/server/company';
import { getCachedAgreementTemplates } from '@/server/config-cache';

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
  const [fullProgress, templates, employer, selectedClientIds, admins] = await Promise.all([
    fetchOnboardingProgress(supabase, companyId),
    getCachedAgreementTemplates().catch(() => []),
    getEmployer(supabase).catch(() => null),
    getSelectedClientIds(),
    // Feeds the wizard's countersigner dropdown; it rendered "— None —" only
    // because this page never passed the list the /contractors page builds.
    listAdmins(supabase).catch(() => []),
  ]);
  const countersigners = admins
    .filter((a) => a.canCountersign)
    .map((a) => ({ userId: a.userId, name: a.name ?? a.email }));
  // Header Client filter: keep only workers assigned to a selected client.
  const progress =
    selectedClientIds.length === 0
      ? fullProgress
      : await fetchWorkerIdsForClients(supabase, selectedClientIds).then((ids) =>
          fullProgress.filter((p) => ids.has(p.workerId)),
        );

  // Open document follow-ups (deferred docs) per contractor — a completed
  // onboarding stays visible while it has open follow-ups (legacy parity).
  // Read via the service client: deferred hiring docs carry a NULL company_id,
  // which RLS on the user client would hide. Non-fatal — empty on error.
  const followups = await fetchOnboardingFollowups(
    createServiceClient(),
    progress.map((p) => p.workerId),
  ).catch(() => ({}));

  return (
    <OnboardingClient
      progress={progress}
      followups={followups}
      companyId={companyId}
      templates={templates}
      employerName={employer?.name ?? 'Aaron Anderson E.H.S. LLC'}
      countersigners={countersigners}
    />
  );
}
