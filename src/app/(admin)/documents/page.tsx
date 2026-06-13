import { DocumentsClient } from '@/components/documents/DocumentsClient';
import { createServerSupabase } from '@/db/clients/server';
import { fetchDocuments } from '@/db/queries/documents';
import { countExpiryBanner } from '@/lib/documents/expiry';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Documents — ABC Kids HR' };

/**
 * Expiring-soon threshold — single source of truth shared with:
 *   - src/lib/documents/expiry.ts (countExpiryBanner / classifyExpiry)
 *   - documents-expiry-check Deno edge fn (mirrors this default)
 */
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

  // Use the shared pure module so the banner threshold is identical to the
  // edge fn classifier (countExpiryBanner in src/lib/documents/expiry.ts).
  const { overdueCount, expiringSoonCount } = countExpiryBanner(
    documents.map((d) => ({ expiresOn: d.expiresOn })),
    new Date(),
    EXPIRY_WARN_DAYS,
  );

  return (
    <DocumentsClient
      documents={documents}
      expiringSoonCount={expiringSoonCount}
      overdueCount={overdueCount}
      expiryWarnDays={EXPIRY_WARN_DAYS}
      companyId={companyId}
      canCountersign={admin.canCountersign}
    />
  );
}
