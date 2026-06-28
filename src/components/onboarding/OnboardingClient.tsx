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
  useToast,
} from '@/components/ui';
import type { AgreementTemplateRow } from '@/db/queries/config';
import type { OnboardingFollowup, OnboardingProgressRow } from '@/db/queries/onboarding';
import { fmtDate } from '@/lib/format';
import { deriveStageInfo } from '@/lib/onboarding/progress';
import { resendHireEmails } from '@/server/actions/portal-admin';

// Heavy wizard (692 lines) loads on first open, not with the onboarding list.
const AddContractorWizard = dynamic(
  () => import('@/components/contractors/AddContractorWizard').then((m) => m.AddContractorWizard),
  { ssr: false },
);

interface Props {
  progress: OnboardingProgressRow[];
  /** Open document follow-ups (deferred docs) per workerId. */
  followups?: Record<string, OnboardingFollowup>;
  companyId: string;
  /** Standard agreement templates (edited here or in Config). */
  templates: AgreementTemplateRow[];
  employerName: string;
  countersigners?: Countersigner[];
  consolidated?: boolean;
}

export const OnboardingClient = ({
  progress,
  followups = {},
  companyId,
  templates,
  employerName,
  countersigners = [],
  consolidated = false,
}: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showDone, setShowDone] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  const handleResendInvite = (row: OnboardingProgressRow) => {
    startTransition(async () => {
      const result = await resendHireEmails({ workerId: row.workerId });
      if (result.ok) notify('Invite email queued.', { type: 'success' });
      else notify(result.error, { type: 'error' });
    });
  };

  // Hide completed onboardings unless "Show completed" is on — BUT keep a
  // completed contractor visible while they still have open follow-ups
  // (deferred docs), matching the legacy default view.
  const visible = showDone
    ? progress
    : progress.filter((r) => !r.completedAt || (followups[r.workerId]?.count ?? 0) > 0);

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
                  background: '#1F3A68',
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

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Hiring &amp; Onboarding</h2>
          <p className="sub">
            Hire a new contractor and track onboarding — agreements signed, profile completed,
            documents reviewed.
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
          <label className="sub" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={showDone}
              onChange={(e) => setShowDone(e.target.checked)}
            />{' '}
            Show completed
          </label>
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
          onRowClick={(row) => router.push(`/onboarding/${row.workerId}`)}
        />
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
