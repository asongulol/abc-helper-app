'use client';

import type { RosterWorker } from '@/db/queries/workers';
import { PayTab } from './PayTab';
import { PersonalTab } from './PersonalTab';
import { PortalLoginTab } from './PortalLoginTab';
import { ProfileTab } from './ProfileTab';
import type { ContractorProfileApi } from './useContractorProfile';

interface Props {
  p: ContractorProfileApi;
  worker: RosterWorker;
  companyId: string;
  companyName?: string | undefined;
  /** All companies (employer + clients) for the engagements assign-to select. */
  companies?: { id: string; name: string }[] | undefined;
}

/**
 * The tablist + active tab panel, shared by the modal (`ProfilePanel`) and the
 * full-page route (`ContractorProfilePage`). All state/handlers come from
 * `useContractorProfile` via `p`.
 */
export function ProfileTabs({ p, worker, companyId, companyName, companies = [] }: Props) {
  const { activeTab, tablist, tabs } = p;
  return (
    <>
      <div
        role="tablist"
        aria-label="Contractor details sections"
        style={{
          display: 'flex',
          gap: 4,
          marginBottom: 16,
          borderBottom: '1px solid var(--border)',
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            {...tablist.tabProps(t.key)}
            className={activeTab === t.key ? 'btn sm' : 'btn ghost sm'}
            style={{ borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ─── Profile tab ─── */}
      {activeTab === 'profile' && (
        <ProfileTab
          worker={worker}
          fullName={p.fullName}
          photoUrl={p.photoUrl}
          photoBusy={p.photoBusy}
          onPhoto={p.handlePhoto}
          form={p.form}
          set={p.set}
          errors={p.errors}
          isPending={p.isPending}
          serverError={p.serverError}
          onSubmit={p.handleSave}
          panelProps={tablist.panelProps()}
        />
      )}

      {/* ─── Pay & payout tab ─── */}
      {activeTab === 'pay' && (
        <PayTab
          worker={worker}
          companyId={companyId}
          companyName={companyName}
          companies={companies}
          engagements={p.engagements}
          updateEng={p.updateEng}
          saveEng={p.saveEng}
          assignTo={p.assignTo}
          setAssignTo={p.setAssignTo}
          handleAssign={p.handleAssign}
          form={p.form}
          set={p.set}
          errors={p.errors}
          isPending={p.isPending}
          serverError={p.serverError}
          onSubmit={p.handleSave}
          panelProps={tablist.panelProps()}
        />
      )}

      {/* ─── Personal / HR tab ─── */}
      {activeTab === 'personal' && (
        <PersonalTab
          form={p.form}
          set={p.set}
          errors={p.errors}
          isPending={p.isPending}
          serverError={p.serverError}
          onSubmit={p.handleSave}
          panelProps={tablist.panelProps()}
        />
      )}

      {/* ─── Portal & login tab ─── */}
      {activeTab === 'portal' && (
        <PortalLoginTab
          worker={worker}
          loginBusy={p.loginBusy}
          tempPassword={p.tempPassword}
          runLogin={p.runLogin}
          panelProps={tablist.panelProps()}
        />
      )}
    </>
  );
}
