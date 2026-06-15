'use client';

import { Modal } from '@/components/ui';
import type {
  AgreementTemplateRow,
  CompanyFullRow,
  HubstaffProjectRow,
  OnboardingConfig,
} from '@/db/queries/config';
import { useState } from 'react';
import { AgreementTemplatesCard } from './AgreementTemplatesCard';
import { ClientsCard } from './ClientsCard';
import { EmployerCard } from './EmployerCard';
import { HubstaffProjectsCard } from './HubstaffProjectsCard';
import { OnboardingConfigCard } from './OnboardingConfigCard';
import { PortalFieldsCard } from './PortalFieldsCard';
import { WiseReconCard } from './WiseReconCard';

type PanelKey = 'employer' | 'clients' | 'hubstaff' | 'portalFields' | 'agreements' | 'onboarding';

interface ConfigClientProps {
  isOwner: boolean;
  employer: CompanyFullRow | null;
  clients: CompanyFullRow[];
  projects: HubstaffProjectRow[];
  templates: AgreementTemplateRow[];
  editableFields: string[];
  onboardingConfig: OnboardingConfig;
}

interface PanelRow {
  key: PanelKey;
  label: string;
  sub: string;
}

const ROWS: readonly PanelRow[] = [
  {
    key: 'employer',
    label: 'Employer',
    sub: 'The payroll home — Aaron Anderson E.H.S. LLC. Every contractor is paid here regardless of which client they serve. Set its Hubstaff org link.',
  },
  {
    key: 'clients',
    label: 'Clients',
    sub: 'Add/edit/archive the clients you invoice (Ability Builders, 123 Baby Talks, 1 World Realty). Assigning a contractor to a client is billing-only and never changes their pay.',
  },
  {
    key: 'hubstaff',
    label: 'Hubstaff Projects → Clients',
    sub: 'Map each Hubstaff project to a client company so tracked time is attributed to the right client (per-client hours).',
  },
  {
    key: 'portalFields',
    label: 'Portal Fields',
    sub: 'Choose which profile fields contractors can edit in the self-service portal.',
  },
  {
    key: 'agreements',
    label: 'Agreement Templates',
    sub: 'Edit the wording of the onboarding agreements (IC, Non-Compete, NDA, BAA).',
  },
  {
    key: 'onboarding',
    label: 'Onboarding Configuration',
    sub: 'Turn onboarding on/off and set the required documents and agreements.',
  },
];

const PANEL_TITLE: Record<PanelKey, string> = {
  employer: 'Employer',
  clients: 'Clients',
  hubstaff: 'Hubstaff projects → clients',
  portalFields: 'Portal — editable fields',
  agreements: 'Agreement templates',
  onboarding: 'Onboarding setup',
};

const PANEL_WIDTH: Record<PanelKey, number> = {
  employer: 640,
  clients: 820,
  hubstaff: 720,
  portalFields: 640,
  agreements: 820,
  onboarding: 860,
};

/**
 * Configuration launcher (manifest 14): the six-row "Configuration" launcher
 * (Employer, Clients, Hubstaff projects, Portal fields, Agreement templates,
 * Onboarding) whose rows each open a panel in a shared Modal, plus the
 * Wise-reconciliation card below — matching the legacy `Configuration()`.
 * Announcements and Admins are topbar modals, NOT config rows. Server data is
 * fetched in the page and passed down; mutations revalidate `/config` so
 * re-opening a panel shows fresh data.
 */
export const ConfigClient = ({
  isOwner,
  employer,
  clients,
  projects,
  templates,
  editableFields,
  onboardingConfig,
}: ConfigClientProps) => {
  const [open, setOpen] = useState<PanelKey | null>(null);
  const close = () => setOpen(null);

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {ROWS.map((r) => (
            <div
              key={r.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                padding: '12px 0',
                borderTop: '1px solid var(--border)',
              }}
            >
              <div>
                <strong>{r.label}</strong>
                <div className="sub" style={{ marginTop: 2 }}>
                  {r.sub}
                </div>
              </div>
              <button type="button" className="btn ghost" onClick={() => setOpen(r.key)}>
                Open
              </button>
            </div>
          ))}
        </div>
      </div>

      {open != null && (
        <Modal title={PANEL_TITLE[open]} onClose={close} maxWidth={PANEL_WIDTH[open]}>
          {open === 'employer' && <EmployerCard employer={employer} onClose={close} />}
          {open === 'clients' && (
            <ClientsCard clients={clients} isOwner={isOwner} onClose={close} />
          )}
          {open === 'hubstaff' && (
            <HubstaffProjectsCard
              projects={projects}
              clients={clients}
              employer={employer}
              onClose={close}
            />
          )}
          {open === 'portalFields' && (
            <PortalFieldsCard selected={editableFields} onClose={close} />
          )}
          {open === 'agreements' && (
            <AgreementTemplatesCard
              templates={templates}
              employerName={employer?.name ?? 'Aaron Anderson E.H.S. LLC'}
              onClose={close}
            />
          )}
          {open === 'onboarding' && (
            <OnboardingConfigCard config={onboardingConfig} onClose={close} />
          )}
        </Modal>
      )}

      <WiseReconCard />
    </>
  );
};
