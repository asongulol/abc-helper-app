'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { AgreementTemplatesCard } from '@/components/config/AgreementTemplatesCard';
import type { Countersigner } from '@/components/contractors/AddContractorWizard';
import {
  Badge,
  EmptyState,
  Modal,
  type SortableColumn,
  SortableTable,
  useTablist,
  useToast,
} from '@/components/ui';
import type { AgreementTemplateRow } from '@/db/queries/config';
import type {
  CurrentTeamRow,
  OnboardingFollowup,
  OnboardingProgressRow,
} from '@/db/queries/onboarding';
import { fmtDate } from '@/lib/format';
import { deriveStageInfo } from '@/lib/onboarding/progress';
import { resendHireEmails } from '@/server/actions/portal-admin';

// Heavy wizards load on first open, not with the onboarding list.
const AddContractorWizard = dynamic(
  () => import('@/components/contractors/AddContractorWizard').then((m) => m.AddContractorWizard),
  { ssr: false },
);
const OnboardCurrentWizard = dynamic(
  () => import('@/components/onboarding/OnboardCurrentWizard').then((m) => m.OnboardCurrentWizard),
  { ssr: false },
);

type Tab = 'hires' | 'team';
const TABS: readonly Tab[] = ['hires', 'team'];

interface Props {
  progress: OnboardingProgressRow[];
  /** Open document follow-ups (deferred docs) per workerId. */
  followups?: Record<string, OnboardingFollowup>;
  /** Current team: active contractors with ≥1 open contract/document item. */
  team: CurrentTeamRow[];
  initialTab?: Tab;
  companyId: string;
  /** Standard agreement templates (edited here or in Config). */
  templates: AgreementTemplateRow[];
  employerName: string;
  countersigners?: Countersigner[];
  consolidated?: boolean;
}

/**
 * A REOPENED onboarding (admin reset: stages cleared, completed_at kept for
 * is_onboarded RLS) is in progress, not complete — key on current_stage, not
 * the timestamp.
 */
const inProgress = (r: OnboardingProgressRow) => r.currentStage !== 'complete' || !r.completedAt;

export const OnboardingClient = ({
  progress,
  followups = {},
  team,
  initialTab = 'hires',
  companyId,
  templates,
  employerName,
  countersigners = [],
  consolidated = false,
}: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [tab, setTab] = useState<Tab>(initialTab);
  const tablist = useTablist(TABS, tab, setTab);
  const [showDone, setShowDone] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  /** Onboard Current wizard: null = closed, '' = open unselected, id = preselected. */
  const [onboardTarget, setOnboardTarget] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);

  const handleResendInvite = (row: OnboardingProgressRow) => {
    startTransition(async () => {
      const result = await resendHireEmails({ workerId: row.workerId });
      if (result.ok) notify('Invite email queued.', { type: 'success' });
      else notify(result.error, { type: 'error' });
    });
  };

  // Hide completed onboardings unless "Show completed" is on. A completed
  // contractor with a document still owed is a Current team row now.
  const openHires = progress.filter(inProgress);
  const visible = showDone ? progress : openHires;

  const columns: ReadonlyArray<SortableColumn<OnboardingProgressRow>> = [
    {
      key: 'workerName',
      label: 'Contractor',
      sortable: true,
      cardTitle: true,
      render: (row) => (
        <>
          {row.workerName}
          {row.nameMismatchFlag && (
            <span title="Signed legal name differs from profile name" style={{ marginLeft: 6 }}>
              ⚠️
            </span>
          )}
        </>
      ),
      accessor: (row) => row.workerName,
    },
    {
      key: 'currentStage',
      label: 'Stage',
      sortable: true,
      render: (row) => deriveStageInfo(stageInput(row)).label,
      accessor: (row) => row.currentStage,
    },
    {
      key: 'progress',
      label: 'Progress',
      sortable: true,
      render: (row) => {
        const pct = deriveStageInfo(stageInput(row)).pct;
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                width: 60,
                height: 6,
                background: '#e5e7eb',
                borderRadius: 999,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: 'var(--navy)',
                }}
              />
            </div>
            <span className="muted" style={{ fontSize: 11 }}>
              {pct}%
            </span>
          </div>
        );
      },
      accessor: (row) => deriveStageInfo(stageInput(row)).pct,
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (row) => {
        const info = deriveStageInfo(stageInput(row));
        const f = followups[row.workerId];
        return (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`pill ${info.tone}`}>{onbStatusLabel(row)}</span>
            {f && f.count > 0 && (
              <Badge tone={f.overdue > 0 ? 'bad' : 'neutral'}>
                📌 {f.count} follow-up{f.overdue > 0 ? ` · ${f.overdue} overdue` : ''}
              </Badge>
            )}
          </span>
        );
      },
      accessor: (row) => (row.completedAt ? 3 : row.stalled ? 1 : 2),
    },
    {
      key: 'updatedAt',
      label: 'Updated',
      sortable: true,
      render: (row) => fmtDate(row.updatedAt),
      accessor: (row) => row.updatedAt,
    },
    {
      key: 'review',
      label: '',
      render: (row) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <Link
            href={`/onboarding/${row.workerId}`}
            className="btn ghost sm"
            onClick={(e) => e.stopPropagation()}
          >
            Review
          </Link>
          <button
            type="button"
            className="btn ghost sm"
            disabled={isPending}
            onClick={(e) => {
              e.stopPropagation();
              handleResendInvite(row);
            }}
          >
            Resend
          </button>
        </div>
      ),
    },
  ];

  const teamColumns: ReadonlyArray<SortableColumn<CurrentTeamRow>> = [
    {
      key: 'workerName',
      label: 'Contractor',
      sortable: true,
      cardTitle: true,
      accessor: (row) => row.workerName,
    },
    {
      key: 'items',
      label: 'Open items',
      sortable: true,
      render: (row) => (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {row.items.map((it) => (
            <Badge key={it.kind} tone={it.tone}>
              {it.label}
            </Badge>
          ))}
        </span>
      ),
      accessor: (row) => row.items.length,
    },
    {
      key: 'actions',
      label: '',
      render: (row) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          {!row.hasLogin && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={consolidated}
              title="No portal login yet — invite them to sign in the app"
              onClick={(e) => {
                e.stopPropagation();
                setOnboardTarget(row.workerId);
              }}
            >
              Onboard current
            </button>
          )}
          <Link
            href={`/contractors/${row.workerId}`}
            className="btn ghost sm"
            onClick={(e) => e.stopPropagation()}
          >
            Open
          </Link>
        </div>
      ),
    },
  ];

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Onboarding &amp; contracts</h2>
          <p className="sub">
            One queue for signatures and documents — new hires working through onboarding, and the
            current team&apos;s contracts and documents still owed.
          </p>
        </div>
        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            className="btn"
            disabled={consolidated}
            title={consolidated ? 'Pick a single company first to hire' : ''}
            onClick={() => setShowWizard(true)}
          >
            + Hire new contractor
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={consolidated}
            title={
              consolidated
                ? 'Pick a single company first'
                : 'Invite an already-added contractor to the portal'
            }
            onClick={() => setOnboardTarget('')}
          >
            Onboard current contractor
          </button>
          {tab === 'hires' && (
            <label className="sub" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={showDone}
                onChange={(e) => setShowDone(e.target.checked)}
              />{' '}
              Show completed
            </label>
          )}
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setShowTemplates(true)}
            title="Edit the standard agreement / contract templates"
          >
            Agreement templates
          </button>
          <button type="button" className="btn ghost sm" onClick={() => router.refresh()}>
            Refresh
          </button>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Onboarding queue"
        style={{
          display: 'flex',
          gap: 4,
          marginBottom: 16,
          borderBottom: '1px solid var(--border)',
          overflowX: 'auto',
        }}
      >
        <button
          type="button"
          {...tablist.tabProps('hires')}
          className={tab === 'hires' ? 'btn sm' : 'btn ghost sm'}
          style={{ borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0' }}
        >
          New hires ({openHires.length})
        </button>
        <button
          type="button"
          {...tablist.tabProps('team')}
          className={tab === 'team' ? 'btn sm' : 'btn ghost sm'}
          style={{ borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0' }}
        >
          Current team ({team.length})
        </button>
      </div>

      {tab === 'hires' && (
        <div {...tablist.panelProps()}>
          {visible.length === 0 ? (
            <EmptyState
              icon="🧭"
              message={
                progress.length > 0 && !showDone
                  ? 'No onboarding in progress. (Completed are hidden — tick “Show completed”.)'
                  : 'No onboarding in progress.'
              }
            />
          ) : (
            <SortableTable
              columns={columns}
              rows={visible}
              rowKey={(r) => r.workerId}
              filterPlaceholder="Filter by name or email…"
              defaultSort={{ key: 'workerName' }}
              onRowClick={(row) => router.push(`/onboarding/${row.workerId}`)}
            />
          )}
        </div>
      )}

      {tab === 'team' && (
        <div {...tablist.panelProps()}>
          {team.length === 0 ? (
            <EmptyState icon="✓" message="Nothing owed — every contract and document is in." />
          ) : (
            <SortableTable
              columns={teamColumns}
              rows={team}
              rowKey={(r) => r.workerId}
              filterPlaceholder="Filter by name…"
              defaultSort={{ key: 'workerName' }}
              onRowClick={(row) => router.push(`/contractors/${row.workerId}`)}
            />
          )}
        </div>
      )}

      {showWizard && (
        <AddContractorWizard
          companyId={companyId}
          countersigners={countersigners}
          onClose={() => setShowWizard(false)}
          onCreated={() => {
            setShowWizard(false);
            router.refresh();
          }}
        />
      )}

      {onboardTarget !== null && (
        <OnboardCurrentWizard
          companyId={companyId}
          companyName={employerName}
          countersigners={countersigners}
          initialWorkerId={onboardTarget || undefined}
          onClose={() => setOnboardTarget(null)}
          onCreated={() => {
            setOnboardTarget(null);
            router.refresh();
          }}
        />
      )}

      {showTemplates && (
        <Modal title="Agreement templates" onClose={() => setShowTemplates(false)} maxWidth={820}>
          <AgreementTemplatesCard templates={templates} employerName={employerName} />
        </Modal>
      )}
    </div>
  );
};

function stageInput(row: OnboardingProgressRow) {
  return {
    stage1Complete: row.stage1Complete,
    stage2Complete: row.stage2Complete,
    stage3Complete: row.stage3Complete,
    completedAt: row.completedAt,
    currentStage: row.currentStage,
    nameMismatchFlag: row.nameMismatchFlag,
    stalled: row.stalled,
  };
}

function onbStatusLabel(row: OnboardingProgressRow): string {
  if (row.completedAt) return 'Complete';
  if (row.stalled) return 'Stalled';
  return 'In progress';
}
