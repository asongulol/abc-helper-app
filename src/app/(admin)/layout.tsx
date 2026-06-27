import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AdminShell } from '@/components/shell/AdminShell';
import { createServerSupabase } from '@/db/clients/server';
import { type AdminRow, listAdmins } from '@/db/queries/admins';
import { fetchPeriodSummaries } from '@/db/queries/payroll';
import { fetchRosterIndex } from '@/db/queries/workers';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId, listCompanies } from '@/server/company';

/**
 * Admin area layout: verifies the signed-in user is an admin (the proxy gate
 * is the first line of defense; this re-verifies at point of use), loads the
 * company list + selection, and renders the shared shell. Also builds the
 * lightweight contractors + periods index that powers the ⌘K command palette.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const [allCompanies, selectedCompanyId] = await Promise.all([
    listCompanies(),
    getSelectedCompanyId(),
  ]);
  // Single-employer deployment: the admin context is ALWAYS the employer
  // (Aaron Anderson). Feed the header switcher only the employer so it shows the
  // tenant name and greys out (no switching into a client). Clients live in
  // Invoicing + per-entry pickers, not the global switcher.
  const companies = allCompanies.filter((c) => c.id === selectedCompanyId);

  let contractors: { id: string; name: string }[] = [];
  let periods: { id: string; label: string; start: string }[] = [];
  // The Admins modal is owner-only — only fetch the roster for owners.
  let admins: AdminRow[] = [];
  if (selectedCompanyId) {
    const db = await createServerSupabase();
    const [roster, periodRows, adminRows] = await Promise.all([
      fetchRosterIndex(db, selectedCompanyId),
      fetchPeriodSummaries(db, selectedCompanyId),
      admin.isOwner ? listAdmins(db) : Promise.resolve([] as AdminRow[]),
    ]);
    contractors = roster.map((w) => ({
      id: w.workerId,
      name: [w.firstName, w.middleName, w.lastName].filter(Boolean).join(' ').trim(),
    }));
    periods = periodRows.map((p) => ({
      id: p.id,
      label: `${p.periodStart} – ${p.periodEnd}`,
      start: p.periodStart,
    }));
    admins = adminRows;
  }

  return (
    <AdminShell
      admin={{
        userId: admin.userId,
        email: admin.email,
        name: admin.name,
        isOwner: admin.isOwner,
      }}
      companies={companies}
      selectedCompanyId={selectedCompanyId}
      contractors={contractors}
      periods={periods}
      admins={admins}
    >
      {children}
    </AdminShell>
  );
}
