import { redirect } from 'next/navigation';
import { PortalProfile } from '@/components/portal/PortalProfile';
import { createServerSupabase } from '@/db/clients/server';
import { fetchOwnProfile } from '@/db/queries/portal';
import { getCurrentWorker } from '@/server/auth/worker';
import { getCachedPortalSettings } from '@/server/config-cache';

export const metadata = { title: 'Profile — Contractor Portal' };

export default async function PortalProfilePage() {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  const supabase = await createServerSupabase();
  const [profile, settings] = await Promise.all([
    fetchOwnProfile(supabase, worker.workerId),
    getCachedPortalSettings(),
  ]);

  const editableFields = settings.editableFields;

  // Auth login email comes from the already-verified session (getCurrentWorker),
  // not a separate auth.getUser() round-trip.
  return (
    <PortalProfile profile={profile} editableFields={editableFields} authEmail={worker.authEmail} />
  );
}
