import { AdminsCard } from '@/components/config/AdminsCard';
import { HolidaysCard } from '@/components/config/HolidaysCard';
import { createServerSupabase } from '@/db/clients/server';
import { listAdmins } from '@/db/queries/admins';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId, listCompanies } from '@/server/company';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Configuration — ABC Kids HR' };

export default async function ConfigPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const [companyId, companies] = await Promise.all([getSelectedCompanyId(), listCompanies()]);

  if (!companyId) {
    return (
      <div className="card">
        <h2>Configuration</h2>
        <p className="sub">No company selected or accessible.</p>
      </div>
    );
  }

  const supabase = await createServerSupabase();
  const admins = await listAdmins(supabase);

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Configuration</h2>
        <p className="sub">Admin management and per-year holiday settings.</p>
      </div>

      <AdminsCard admins={admins} companyOptions={companies} isOwner={admin.isOwner} />

      <HolidaysCard />
    </>
  );
}
