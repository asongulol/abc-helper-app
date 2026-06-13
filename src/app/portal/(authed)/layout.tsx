import { PortalShell } from '@/components/portal/PortalShell';
import { getCurrentWorker } from '@/server/auth/worker';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Authenticated portal layout — verifies the contractor session and renders
 * the portal shell. Unauthenticated requests redirect to /portal/login.
 */
export default async function PortalAuthedLayout({ children }: { children: ReactNode }) {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  return (
    <PortalShell
      workerName={`${worker.firstName}${worker.lastName ? ` ${worker.lastName}` : ''}`}
      onboarded={worker.onboarded}
    >
      {children}
    </PortalShell>
  );
}
