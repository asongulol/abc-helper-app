import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { PortalShell } from '@/components/portal/PortalShell';
import { createServerSupabase } from '@/db/clients/server';
import { getCurrentWorker } from '@/server/auth/worker';

/**
 * Authenticated portal layout — verifies the contractor session and renders
 * the portal shell. Unauthenticated requests redirect to /portal/login.
 */
export default async function PortalAuthedLayout({ children }: { children: ReactNode }) {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  // Docs needing the contractor's attention (HR bounced back), for the nav badge.
  const supabase = await createServerSupabase();
  const { count } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('worker_id', worker.workerId)
    .eq('review_status', 'needs_replacement');

  return (
    <PortalShell
      workerName={worker.firstName}
      onboarded={worker.onboarded}
      {...(worker.email ? { email: worker.email } : {})}
      docsBadge={count ?? 0}
    >
      {children}
    </PortalShell>
  );
}
