import { AutoPrint } from '@/components/print/AutoPrint';
import { PaySlip } from '@/components/print/PaySlip';
import { createServerSupabase } from '@/db/clients/server';
import { fetchPaymentDetail } from '@/db/queries/payroll';
import { getCurrentWorker } from '@/server/auth/worker';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Pay slip — Aaron Anderson E.H.S. LLC' };

export default async function StatementPrintPage({
  params,
}: {
  params: Promise<{ paymentId: string }>;
}) {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  const { paymentId } = await params;
  const supabase = await createServerSupabase();
  const pay = await fetchPaymentDetail(supabase, paymentId);
  // RLS already scopes the read to the authenticated worker; the explicit
  // ownership assertion is defence-in-depth (404 on a foreign / unknown id).
  if (!pay || pay.workerId !== worker.workerId) notFound();

  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <AutoPrint />
      <PaySlip pay={pay} />
    </div>
  );
}
