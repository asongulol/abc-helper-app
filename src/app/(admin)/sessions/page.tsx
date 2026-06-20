import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SessionsClient } from '@/components/sessions/SessionsClient';
import { createServerSupabase } from '@/db/clients/server';
import { fetchActiveClients } from '@/db/queries/invoicing';
import { getCurrentAdmin } from '@/server/auth/admin';

export const metadata: Metadata = {
  title: 'Sessions — Aaron Anderson E.H.S. LLC',
};

export default async function SessionsPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const supabase = await createServerSupabase();
  const clients = await fetchActiveClients(supabase);

  // Default window: current month to date (matches Invoicing).
  const now = new Date();
  const defaultFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const defaultTo = now.toISOString().slice(0, 10);

  return <SessionsClient clients={clients} defaultFrom={defaultFrom} defaultTo={defaultTo} />;
}
