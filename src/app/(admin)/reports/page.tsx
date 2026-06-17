import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ReportsClient } from '@/components/reports/ReportsClient';
import { getReportsData } from '@/server/actions/reports-detail';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';

export const metadata: Metadata = {
  title: 'Reports — Aaron Anderson E.H.S. LLC',
};

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

  const res = await getReportsData(companyId);
  if (!res.ok) {
    return (
      <div className="card">
        <h2>Reports</h2>
        <p className="sub">{res.error}</p>
      </div>
    );
  }

  return <ReportsClient companyId={companyId} data={res.data} />;
}
