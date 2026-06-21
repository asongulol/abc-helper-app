import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { InvoicingClient } from '@/components/invoicing/InvoicingClient';
import { createServerSupabase } from '@/db/clients/server';
import { fetchActiveClients, fetchEmployerCompanyId, fetchInvoices } from '@/db/queries/invoicing';
import { getCurrentAdmin } from '@/server/auth/admin';

export const metadata: Metadata = {
  title: 'Invoicing — Aaron Anderson E.H.S. LLC',
};

export default async function InvoicingPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const supabase = await createServerSupabase();
  const [clients, invoices, employerId] = await Promise.all([
    fetchActiveClients(supabase),
    fetchInvoices(supabase),
    fetchEmployerCompanyId(supabase),
  ]);

  // Default window: current month to date.
  const now = new Date();
  const defaultFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const defaultTo = now.toISOString().slice(0, 10);

  return (
    <InvoicingClient
      clients={clients}
      invoices={invoices}
      employerId={employerId}
      defaultFrom={defaultFrom}
      defaultTo={defaultTo}
    />
  );
}
