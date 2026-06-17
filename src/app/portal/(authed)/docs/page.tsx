import { redirect } from 'next/navigation';
import { PortalDocs } from '@/components/portal/PortalDocs';
import { createServerSupabase } from '@/db/clients/server';
import { fetchOwnDocuments } from '@/db/queries/portal';
import { fetchOutstandingDocSlots } from '@/server/actions/portal-docs';
import { getCurrentWorker } from '@/server/auth/worker';

export default async function PortalDocsPage() {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  const supabase = await createServerSupabase();
  const [documents, outstanding] = await Promise.all([
    fetchOwnDocuments(supabase, worker.workerId),
    fetchOutstandingDocSlots(),
  ]);
  return <PortalDocs documents={documents} outstanding={outstanding} />;
}
