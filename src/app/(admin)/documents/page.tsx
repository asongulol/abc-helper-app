import { DocumentsClient } from '@/components/documents/DocumentsClient';
import { createServerSupabase } from '@/db/clients/server';
import { fetchDocuments } from '@/db/queries/documents';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Documents — ABC Kids HR' };

// Expiring-soon threshold (matches documents-expiry-check edge fn default).
const EXPIRY_WARN_DAYS = 30;

export default async function DocumentsPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Documents</h2>
        <p className="sub">No company selected. Please contact the owner.</p>
      </div>
    );
  }

  const supabase = await createServerSupabase();
  const documents = await fetchDocuments(supabase, companyId);

  const today = new Date();
  const warnThreshold = new Date(today.getTime() + EXPIRY_WARN_DAYS * 86_400_000);

  const expiringSoon = documents.filter((d) => {
    if (!d.expiresOn) return false;
    const exp = new Date(`${d.expiresOn}T00:00:00Z`);
    return exp >= today && exp <= warnThreshold;
  });
  const overdue = documents.filter((d) => {
    if (!d.expiresOn) return false;
    return new Date(`${d.expiresOn}T00:00:00Z`) < today;
  });

  return (
    <DocumentsClient
      documents={documents}
      expiringSoonCount={expiringSoon.length}
      overdueCount={overdue.length}
      expiryWarnDays={EXPIRY_WARN_DAYS}
      companyId={companyId}
      canCountersign={admin.canCountersign}
    />
  );
}
