import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { AutoPrint } from '@/components/print/AutoPrint';
import { PaySlip } from '@/components/print/PaySlip';
import { createServerSupabase } from '@/db/clients/server';
import { fetchPaymentDetail } from '@/db/queries/payroll';
import { getCurrentAdmin } from '@/server/auth/admin';

export const metadata: Metadata = {
  title: 'Pay slip — Aaron Anderson E.H.S. LLC',
};

export default async function PaySlipPrintPage({
  params,
}: {
  params: Promise<{ paymentId: string }>;
}) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const { paymentId } = await params;
  const supabase = await createServerSupabase();
  const pay = await fetchPaymentDetail(supabase, paymentId);
  if (!pay) notFound();

  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <AutoPrint />
      <PaySlip pay={pay} />
    </div>
  );
}
