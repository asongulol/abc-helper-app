import { redirect } from 'next/navigation';
import { PortalTime } from '@/components/portal/PortalTime';
import { createServerSupabase } from '@/db/clients/server';
import { fetchOwnTimeEntries } from '@/db/queries/portal';
import { getCurrentWorker } from '@/server/auth/worker';

export const metadata = { title: 'Time — Contractor Portal' };

export default async function PortalTimePage() {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  // time_entries_contractor_read requires is_onboarded(); show a notice instead
  // of an empty table while onboarding.
  if (!worker.onboarded) {
    return (
      <div className="card">
        <h2>Time</h2>
        <p className="sub">Your time history will appear here once your onboarding is complete.</p>
      </div>
    );
  }

  const supabase = await createServerSupabase();
  const entries = await fetchOwnTimeEntries(supabase, worker.workerId);
  return <PortalTime entries={entries} />;
}
