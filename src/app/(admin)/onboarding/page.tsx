import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { OnboardingClient } from '@/components/onboarding/OnboardingClient';
import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import { listAdmins } from '@/db/queries/admins';
import { getEmployer } from '@/db/queries/config';
import {
  fetchCurrentTeam,
  fetchOnboardingFollowups,
  fetchOnboardingProgress,
} from '@/db/queries/onboarding';
import { fetchWorkerIdsForClients } from '@/db/queries/workers';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedClientIds, getSelectedCompanyId } from '@/server/company';
import { getCachedAgreementTemplates } from '@/server/config-cache';

export const metadata: Metadata = {
  title: 'Onboarding & contracts — Aaron Anderson E.H.S. LLC',
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Onboarding &amp; contracts</h2>
        <p className="sub">No company selected. Please contact the owner.</p>
      </div>
    );
  }

  const supabase = await createServerSupabase();
  const svc = createServiceClient();
  const today = new Date().toISOString().slice(0, 10);
  // `progress`/`team` are the queue and gate the page; `templates`/`employer`
  // only feed the optional "Agreement templates" modal, so keep them non-fatal —
  // a transient error there must not take down the whole onboarding screen.
  const [fullProgress, fullTeam, templates, employer, selectedClientIds, admins, { tab }] =
    await Promise.all([
      fetchOnboardingProgress(supabase, companyId),
      // Service client: contractor_logins is self-RLS and deferred hiring docs
      // carry a NULL company_id (see fetchOnboardingFollowups).
      fetchCurrentTeam(svc, companyId, today),
      getCachedAgreementTemplates().catch(() => []),
      getEmployer(supabase).catch(() => null),
      getSelectedClientIds(),
      // Feeds the wizard's countersigner dropdown; it rendered "— None —" only
      // because this page never passed the list the /contractors page builds.
      listAdmins(supabase).catch(() => []),
      searchParams,
    ]);
  const countersigners = admins
    .filter((a) => a.canCountersign)
    .map((a) => ({ userId: a.userId, name: a.name ?? a.email }));
  // Header Client filter: keep only workers assigned to a selected client.
  const clientIds =
    selectedClientIds.length === 0
      ? null
      : await fetchWorkerIdsForClients(supabase, selectedClientIds);
  const inClient = <T extends { workerId: string }>(rows: T[]): T[] =>
    clientIds ? rows.filter((r) => clientIds.has(r.workerId)) : rows;
  const progress = inClient(fullProgress);
  const team = inClient(fullTeam);

  // Open document follow-ups (deferred docs) per contractor, for the New hires
  // badge. Non-fatal — empty on error.
  const followups = await fetchOnboardingFollowups(
    svc,
    progress.map((p) => p.workerId),
  ).catch(() => ({}));

  return (
    <OnboardingClient
      progress={progress}
      followups={followups}
      team={team}
      initialTab={tab === 'team' ? 'team' : 'hires'}
      companyId={companyId}
      templates={templates}
      employerName={employer?.name ?? 'Aaron Anderson E.H.S. LLC'}
      countersigners={countersigners}
    />
  );
}
