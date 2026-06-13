import { ReportsClient } from '@/components/reports/ReportsClient';
import { createServerSupabase } from '@/db/clients/server';
import { fetchContractorYtd, fetchReportPeriods } from '@/db/queries/reports';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Reports — ABC Kids HR' };

export default async function ReportsPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Reports</h2>
        <p className="sub">No company selected. Please contact the owner.</p>
      </div>
    );
  }

  const currentYear = new Date().getFullYear();
  // Default: current year to date
  const fromDate = `${currentYear}-01-01`;
  const toDate = new Date().toISOString().slice(0, 10);

  const supabase = await createServerSupabase();
  const [periods, ytd] = await Promise.all([
    fetchReportPeriods(supabase, companyId, fromDate, toDate),
    fetchContractorYtd(supabase, companyId, currentYear),
  ]);

  return (
    <ReportsClient
      periods={periods}
      ytd={ytd}
      companyId={companyId}
      defaultFrom={fromDate}
      defaultTo={toDate}
      currentYear={currentYear}
    />
  );
}
