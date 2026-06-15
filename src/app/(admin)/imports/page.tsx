import { DeleteImportsClient } from '@/components/imports/DeleteImportsClient';
import { fetchImportBatchGroups } from '@/server/actions/import';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Delete Imports — Aaron Anderson E.H.S. LLC' };

export default async function ImportsPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Delete imports</h2>
        <p className="sub">No company selected. Please contact the owner.</p>
      </div>
    );
  }

  const res = await fetchImportBatchGroups(companyId);
  const batches = res.ok ? res.data : [];

  return <DeleteImportsClient companyId={companyId} batches={batches} />;
}
