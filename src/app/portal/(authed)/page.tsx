import { PortalDashboard } from '@/components/portal/PortalDashboard';
import { createServerSupabase } from '@/db/clients/server';
import {
  fetchAnnouncements,
  fetchLatestMoodCheckin,
  fetchOwnNotifications,
  fetchOwnPayments,
} from '@/db/queries/portal';
import { getCurrentWorker } from '@/server/auth/worker';
import { redirect } from 'next/navigation';

export default async function PortalHomePage() {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  const supabase = await createServerSupabase();
  const [announcements, notifications, payments, latestCheckin] = await Promise.all([
    fetchAnnouncements(supabase),
    fetchOwnNotifications(supabase, worker.workerId),
    fetchOwnPayments(supabase, worker.workerId),
    fetchLatestMoodCheckin(supabase, worker.workerId),
  ]);

  const latestPayment = payments[0] ?? null;
  const todayManila = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(
    new Date(),
  );
  const checkedInToday =
    latestCheckin !== null && latestCheckin.created_at.slice(0, 10) === todayManila;

  return (
    <PortalDashboard
      workerName={worker.firstName}
      onboarded={worker.onboarded}
      announcements={announcements}
      notifications={notifications}
      latestPayment={latestPayment}
      checkedInToday={checkedInToday}
      workerId={worker.workerId}
    />
  );
}
