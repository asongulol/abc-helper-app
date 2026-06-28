import { redirect } from 'next/navigation';
import { ContractorsClient } from '@/components/contractors/ContractorsClient';
import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import { listAdmins } from '@/db/queries/admins';
import { listAnnouncementsAll } from '@/db/queries/config';
import { fetchRates } from '@/db/queries/payroll';
import { fetchRoster, fetchWorkerClientsMap, type RosterWorker } from '@/db/queries/workers';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId, listCompanies } from '@/server/company';

export const metadata = { title: 'Contractors — Aaron Anderson E.H.S. LLC' };

export default async function ContractorsPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Contractors</h2>
        <p className="sub">No company selected or accessible. Please contact the owner.</p>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const db = await createServerSupabase();

  const [roster, allRates, admins, announcements] = await Promise.all([
    fetchRoster(db, companyId),
    fetchRates(db, companyId),
    listAdmins(db),
    listAnnouncementsAll(db),
  ]);
  const countersigners = admins
    .filter((a) => a.canCountersign)
    .map((a) => ({ userId: a.userId, name: a.name ?? a.email }));

  const [clientsByWorker, companies] = await Promise.all([
    fetchWorkerClientsMap(
      db,
      roster.map((w) => w.workerId),
    ),
    listCompanies(),
  ]);

  // Batch-sign avatar URLs for the roster (private bucket) so the table can show
  // contractor photos; workers without a photo fall back to initials in the UI.
  const photoUrlByWorker: Record<string, string> = {};
  const withPhotos = roster.filter((w): w is RosterWorker & { photoUrl: string } => !!w.photoUrl);
  if (withPhotos.length > 0) {
    const svc = createServiceClient();
    const { data: signed } = await svc.storage.from('avatars').createSignedUrls(
      withPhotos.map((w) => w.photoUrl),
      600,
    );
    const byPath = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
    for (const w of withPhotos) {
      const url = byPath.get(w.photoUrl);
      if (url) photoUrlByWorker[w.workerId] = url;
    }
  }

  return (
    <ContractorsClient
      companyId={companyId}
      roster={roster}
      allRates={allRates}
      today={today}
      isOwner={admin.isOwner}
      countersigners={countersigners}
      clientsByWorker={clientsByWorker}
      companies={companies}
      announcements={announcements}
      photoUrlByWorker={photoUrlByWorker}
    />
  );
}
