import { PortalStatements } from '@/components/portal/PortalStatements';
import { createServerSupabase } from '@/db/clients/server';
import { fetchOwnPayments } from '@/db/queries/portal';
import { getCurrentWorker } from '@/server/auth/worker';
import { redirect } from 'next/navigation';

export default async function PortalStatementsPage() {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  const supabase = await createServerSupabase();
  const payments = await fetchOwnPayments(supabase, worker.workerId);

  return <PortalStatements payments={payments} />;
}
