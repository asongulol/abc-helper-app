import { ImportBatchRowClient } from '@/components/imports/ImportBatchRow';
import { EmptyState } from '@/components/ui';
import { createServerSupabase } from '@/db/clients/server';
import { fetchImportBatches } from '@/db/queries/time';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Delete Imports — ABC Kids HR' };

export default async function ImportsPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Delete Imports</h2>
        <p className="sub">No company selected. Please contact the owner.</p>
      </div>
    );
  }

  const db = await createServerSupabase();
  const batches = await fetchImportBatches(db, companyId);

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Delete Imports</h2>
        <p className="sub">
          Each row is an import batch (manual CSV or manual hours entry). Deleting removes all time
          entries in the batch. Blocked if any entry falls inside a locked or paid pay period —
          unlock that period first.
        </p>
      </div>

      <div className="card">
        {batches.length === 0 ? (
          <EmptyState icon="🗂" message="No import batches found for this company." />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Batch ID</th>
                  <th>Date span</th>
                  <th>Entries</th>
                  <th>Total hours</th>
                  <th>Approval</th>
                  <th>First name</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <ImportBatchRowClient key={batch.batchId} companyId={companyId} batch={batch} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
