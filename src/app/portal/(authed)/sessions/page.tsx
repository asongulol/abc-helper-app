import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PortalSessions } from '@/components/portal/PortalSessions';
import { createServiceClient } from '@/db/clients/service';
import { fetchWorkerClients, fetchWorkerSessions } from '@/db/queries/sessions';
import { getCurrentWorker } from '@/server/auth/worker';

export const metadata: Metadata = { title: 'Sessions — Contractor Portal' };

export default async function PortalSessionsPage() {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  if (!worker.onboarded) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Sessions</h2>
        <p className="sub">You can record sessions once your onboarding is complete.</p>
      </div>
    );
  }

  // Service client (filtered to this worker) — worker_companies/companies are
  // admin-only under RLS, so reads go through the service role after the
  // getCurrentWorker() identity check above.
  const svc = createServiceClient();
  const [clients, sessions] = await Promise.all([
    fetchWorkerClients(svc, worker.workerId),
    fetchWorkerSessions(svc, worker.workerId),
  ]);

  const today = new Date().toISOString().slice(0, 10);

  return <PortalSessions clients={clients} sessions={sessions} defaultDate={today} />;
}
