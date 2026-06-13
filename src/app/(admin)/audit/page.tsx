import { AuditShell } from '@/components/audit/AuditShell';
import { createServerSupabase } from '@/db/clients/server';
import { getAuditLogPage } from '@/db/queries/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Audit Log — ABC Kids HR' };

const PAGE_SIZE = 50;

interface SearchParams {
  page?: string;
  q?: string;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Audit Log</h2>
        <p className="sub">No company selected or accessible.</p>
      </div>
    );
  }

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? '1') || 1);
  const filter = sp.q ?? '';

  const supabase = await createServerSupabase();
  const { rows, total } = await getAuditLogPage(supabase, companyId, {
    page,
    pageSize: PAGE_SIZE,
    ...(filter.trim() ? { filter: filter.trim() } : {}),
  });

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Audit Log</h2>
        <p className="sub">
          All significant mutations for this company — newest first. Click Detail to inspect the
          JSON payload.
        </p>
      </div>
      <div className="card">
        <AuditShell
          rows={rows}
          total={total}
          page={page}
          pageSize={PAGE_SIZE}
          filter={filter}
          companyId={companyId}
        />
      </div>
    </>
  );
}
