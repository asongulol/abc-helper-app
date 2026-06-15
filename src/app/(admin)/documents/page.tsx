import { DocumentsClient } from '@/components/documents/DocumentsClient';
import { createServerSupabase } from '@/db/clients/server';
import { fetchDocuments } from '@/db/queries/documents';
import { fetchRoster } from '@/db/queries/workers';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Documents — Aaron Anderson E.H.S. LLC' };

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
  const [documents, roster] = await Promise.all([
    fetchDocuments(supabase, companyId),
    fetchRoster(supabase, companyId),
  ]);

  // Contractor dropdown options (de-duped by worker, sorted by name) — legacy
  // builds nameById from worker_companies then sorts alphabetically.
  const nameById = new Map<string, string>();
  for (const w of roster) {
    const name = [w.firstName, w.middleName, w.lastName].filter(Boolean).join(' ').trim();
    if (name) nameById.set(w.workerId, name);
  }
  const workerOptions = Array.from(nameById, ([id, name]) => ({ id, name })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return (
    <DocumentsClient
      documents={documents}
      workerOptions={workerOptions}
      companyId={companyId}
      consolidated={false}
    />
  );
}
