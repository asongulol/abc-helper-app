import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { PortalShell } from '@/components/portal/PortalShell';
import { createServerSupabase } from '@/db/clients/server';
import { getCurrentWorker } from '@/server/auth/worker';

/**
 * Authenticated portal layout — verifies the contractor session and renders
 * the portal shell. Unauthenticated requests redirect to /portal/login (the
 * proxy gate is the first line of defense and carries `?next=` — see proxy.ts).
 */
export default async function PortalAuthedLayout({ children }: { children: ReactNode }) {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  // Docs needing the contractor's attention (HR bounced back), for the nav badge.
  const supabase = await createServerSupabase();
  const [{ count }, { data: progress }] = await Promise.all([
    supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('worker_id', worker.workerId)
      .eq('review_status', 'needs_replacement'),
    // An admin can reopen onboarding for an already-onboarded contractor
    // (re-sign the packet, refresh info/docs). `onboarded` stays true — it
    // gates RLS and the work tabs — so the shell needs this second signal to
    // resurface the Onboarding tab until they finish again.
    supabase
      .from('onboarding_progress')
      .select('current_stage')
      .eq('worker_id', worker.workerId)
      .maybeSingle(),
  ]);

  return (
    <PortalShell
      workerName={worker.firstName}
      onboarded={worker.onboarded}
      onboardingOpen={!!progress && progress.current_stage !== 'complete'}
      {...(worker.email ? { email: worker.email } : {})}
      docsBadge={count ?? 0}
    >
      {children}
    </PortalShell>
  );
}
