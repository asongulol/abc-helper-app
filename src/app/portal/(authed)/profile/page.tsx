import { redirect } from 'next/navigation';
import { PortalProfile } from '@/components/portal/PortalProfile';
import { createServerSupabase } from '@/db/clients/server';
import { fetchOwnProfile, fetchPortalSettings } from '@/db/queries/portal';
import { getCurrentWorker } from '@/server/auth/worker';

export default async function PortalProfilePage() {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  const supabase = await createServerSupabase();
  const [profile, settings, { data: auth }] = await Promise.all([
    fetchOwnProfile(supabase, worker.workerId),
    fetchPortalSettings(supabase),
    supabase.auth.getUser(),
  ]);

  const editableFields: string[] = Array.isArray(settings?.editable_fields)
    ? (settings.editable_fields as string[])
    : [];

  return (
    <PortalProfile
      profile={profile}
      editableFields={editableFields}
      authEmail={auth.user?.email ?? null}
    />
  );
}
