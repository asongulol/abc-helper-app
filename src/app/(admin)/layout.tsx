import { AdminShell } from '@/components/shell/AdminShell';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId, listCompanies } from '@/server/company';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Admin area layout: verifies the signed-in user is an admin (the proxy gate
 * is the first line of defense; this re-verifies at point of use), loads the
 * company list + selection, and renders the shared shell.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const [companies, selectedCompanyId] = await Promise.all([
    listCompanies(),
    getSelectedCompanyId(),
  ]);

  return (
    <AdminShell
      admin={{ email: admin.email, name: admin.name, isOwner: admin.isOwner }}
      companies={companies}
      selectedCompanyId={selectedCompanyId}
    >
      {children}
    </AdminShell>
  );
}
