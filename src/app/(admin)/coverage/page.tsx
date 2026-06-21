import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CoverageClient } from '@/components/coverage/CoverageClient';
import { createServerSupabase } from '@/db/clients/server';
import { fetchCoverageRoster } from '@/db/queries/coverage';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';

export const metadata: Metadata = {
  title: 'Coverage — Aaron Anderson E.H.S. LLC',
};

export default async function CoveragePage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Coverage</h2>
        <p className="sub">No company selected or accessible. Please contact the owner.</p>
      </div>
    );
  }

  const supabase = await createServerSupabase();
  const roster = await fetchCoverageRoster(supabase, companyId);

  return <CoverageClient companyId={companyId} roster={roster} />;
}
