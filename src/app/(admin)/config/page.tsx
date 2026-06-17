import { redirect } from 'next/navigation';
import { ConfigClient } from '@/components/config/ConfigClient';
import { createServerSupabase } from '@/db/clients/server';
import {
  getEmployer,
  getPortalSettings,
  listAgreementTemplates,
  listClients,
  listHubstaffProjects,
  parseOnboardingConfig,
} from '@/db/queries/config';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';

export const metadata = { title: 'Configuration — Aaron Anderson E.H.S. LLC' };

export default async function ConfigPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();

  if (!companyId) {
    return (
      <div className="card">
        <h2>Configuration</h2>
        <p className="sub">No company selected or accessible.</p>
      </div>
    );
  }

  const supabase = await createServerSupabase();
  const [employer, clients, projects, templates, portalSettings] = await Promise.all([
    getEmployer(supabase),
    listClients(supabase),
    listHubstaffProjects(supabase),
    listAgreementTemplates(supabase),
    getPortalSettings(supabase),
  ]);

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Configuration</h2>
        <p className="sub">Admin setup and global maintenance tools.</p>
      </div>

      <ConfigClient
        isOwner={admin.isOwner}
        employer={employer}
        clients={clients}
        projects={projects}
        templates={templates}
        editableFields={portalSettings.editableFields}
        onboardingConfig={parseOnboardingConfig(portalSettings.onboardingConfigRaw)}
      />
    </>
  );
}
