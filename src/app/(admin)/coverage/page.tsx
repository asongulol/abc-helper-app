import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CoverageClient } from '@/components/coverage/CoverageClient';
import { createServerSupabase } from '@/db/clients/server';
import { fetchCoverageRoster } from '@/db/queries/coverage';
import { previousPeriod } from '@/lib/dates/periods';
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

  // Same arrears period the Overview measures gaps against — this page is where
  // its "Under expected hours → Investigate" link lands, so it must show that
  // period, not the one still accruing.
  const period = previousPeriod(new Date().toISOString().slice(0, 10));

  const supabase = await createServerSupabase();
  const roster = await fetchCoverageRoster(supabase, companyId, period.start, period.end);

  return <CoverageClient companyId={companyId} roster={roster} period={period} />;
}
