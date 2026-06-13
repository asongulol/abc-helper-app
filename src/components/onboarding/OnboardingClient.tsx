'use client';

import {
  Badge,
  EmptyState,
  Modal,
  type SortableColumn,
  SortableTable,
  useToast,
} from '@/components/ui';
import type { OnboardingProgressRow } from '@/db/queries/onboarding';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { deriveStageInfo } from '@/lib/onboarding/progress';
import { createPortalLogin, resendHireEmails } from '@/server/actions/portal-admin';
import { useId, useState, useTransition } from 'react';
import { OnboardingDrilldown } from './OnboardingDrilldown';

interface Props {
  progress: OnboardingProgressRow[];
  companyId: string;
  canCountersign: boolean;
}

export const OnboardingClient = ({ progress, canCountersign }: Props) => {
  const idWorkerId = useId();
  const idLoginEmail = useId();
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();
  const [drillWorker, setDrillWorker] = useState<OnboardingProgressRow | null>(null);
  const [createLoginModal, setCreateLoginModal] = useState<OnboardingProgressRow | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginResult, setLoginResult] = useState<{ tempPassword: string } | null>(null);

  const handleCreateLogin = () => {
    if (!createLoginModal) return;
    if (!loginEmail.trim()) {
      notify('Email is required.', { type: 'error' });
      return;
    }
    startTransition(async () => {
      const result = await createPortalLogin({
        workerId: createLoginModal.workerId,
        email: loginEmail.trim().toLowerCase(),
      });
      if (result.ok) {
        setLoginResult(
          result.data?.tempPassword ? { tempPassword: result.data.tempPassword } : null,
        );
        notify('Portal login created.', { type: 'success' });
      } else {
        notify(result.error, { type: 'error' });
      }
    });
  };

  const handleResendInvite = (row: OnboardingProgressRow) => {
    startTransition(async () => {
      const result = await resendHireEmails({ workerId: row.workerId });
      if (result.ok) notify('Invite email queued.', { type: 'success' });
      else notify(result.error, { type: 'error' });
    });
  };

  const columns: ReadonlyArray<SortableColumn<OnboardingProgressRow>> = [
    {
      key: 'workerName',
      label: 'Contractor',
      sortable: true,
      cardTitle: true,
    },
    {
      key: 'currentStage',
      label: 'Stage',
      sortable: true,
      render: (row) => {
        const info = deriveStageInfo({
          stage1Complete: row.stage1Complete,
          stage2Complete: row.stage2Complete,
          stage3Complete: row.stage3Complete,
          completedAt: row.completedAt,
          currentStage: row.currentStage,
          nameMismatchFlag: row.nameMismatchFlag,
          stalled: row.stalled,
        });
        return <Badge tone={info.tone}>{info.label}</Badge>;
      },
      accessor: (row) => row.currentStage,
    },
    {
      key: 'stage1Complete',
      label: 'Signed',
      render: (row) => (row.stage1Complete ? '✓' : '—'),
      accessor: (row) => (row.stage1Complete ? 1 : 0),
    },
    {
      key: 'stage2Complete',
      label: 'Profile',
      render: (row) => (row.stage2Complete ? '✓' : '—'),
      accessor: (row) => (row.stage2Complete ? 1 : 0),
    },
    {
      key: 'stage3Complete',
      label: 'Docs',
      render: (row) => (row.stage3Complete ? '✓' : '—'),
      accessor: (row) => (row.stage3Complete ? 1 : 0),
    },
    {
      key: 'nameMismatchFlag',
      label: 'Name ⚠',
      render: (row) =>
        row.nameMismatchFlag ? (
          <Badge tone="warn" title="Legal name mismatch on signature">
            Mismatch
          </Badge>
        ) : (
          '—'
        ),
    },
    {
      key: 'startedAt',
      label: 'Started',
      sortable: true,
      render: (row) => fmtDate(row.startedAt),
      accessor: (row) => row.startedAt,
    },
    {
      key: 'completedAt',
      label: 'Completed',
      sortable: true,
      render: (row) => fmtDateTime(row.completedAt),
      accessor: (row) => row.completedAt,
    },
    {
      key: 'actions',
      label: '',
      render: (row) => (
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            className="btn sm"
            onClick={(e) => {
              e.stopPropagation();
              setDrillWorker(row);
            }}
          >
            Details
          </button>
          <button
            type="button"
            className="btn sm ghost"
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

  // Summary counts
  const complete = progress.filter((p) => p.completedAt).length;
  const inProgress = progress.filter((p) => !p.completedAt).length;
  const stalled = progress.filter((p) => p.stalled).length;

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Onboarding</h2>
        <p className="sub">
          Pipeline of contractor onboarding — {complete} complete, {inProgress} in progress
          {stalled > 0 ? `, ${stalled} stalled` : ''}.
        </p>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setCreateLoginModal({
                workerId: '',
                workerName: '',
                workerStatus: 'active',
                currentStage: 'stage1_sign',
                stage1Complete: false,
                stage2Complete: false,
                stage3Complete: false,
                stage1LastKind: null,
                stage2LastTab: null,
                nameMismatchFlag: false,
                stalled: false,
                completedAt: null,
                startedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
              setLoginEmail('');
              setLoginResult(null);
            }}
          >
            + Create portal login
          </button>
        </div>

        <SortableTable
          columns={columns}
          rows={progress}
          rowKey={(r) => r.workerId}
          filterPlaceholder="Filter contractors…"
          emptyMessage={
            <EmptyState
              icon="🧭"
              message="No onboarding records yet. Create portal logins for new hires."
            />
          }
          onRowClick={(row) => setDrillWorker(row)}
        />
      </div>

      {drillWorker !== null && (
        <OnboardingDrilldown
          row={drillWorker}
          canCountersign={canCountersign}
          onClose={() => setDrillWorker(null)}
        />
      )}

      {createLoginModal !== null && (
        <Modal
          title="Create portal login"
          onClose={() => {
            setCreateLoginModal(null);
            setLoginResult(null);
          }}
          maxWidth={420}
        >
          {loginResult !== null ? (
            <>
              <p style={{ color: 'var(--good)', marginBottom: 8 }}>Login created successfully.</p>
              <p className="sub">Temporary password:</p>
              <code
                style={{
                  display: 'block',
                  background: 'var(--surface2)',
                  padding: '6px 10px',
                  borderRadius: 6,
                  marginBottom: 12,
                  letterSpacing: '0.05em',
                }}
              >
                {loginResult.tempPassword}
              </code>
              <p className="sub">
                Share this securely with the contractor. They will be prompted to change it on first
                sign-in.
              </p>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setCreateLoginModal(null);
                  setLoginResult(null);
                }}
              >
                Done
              </button>
            </>
          ) : (
            <>
              <label className="sub" htmlFor={idWorkerId}>
                Worker ID
              </label>
              <input
                id={idWorkerId}
                type="text"
                placeholder="Worker UUID"
                value={createLoginModal.workerId}
                onChange={(e) =>
                  setCreateLoginModal({ ...createLoginModal, workerId: e.target.value })
                }
                style={{ marginBottom: 10 }}
              />
              <label className="sub" htmlFor={idLoginEmail}>
                Email
              </label>
              <input
                id={idLoginEmail}
                type="email"
                placeholder="contractor@example.com"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                style={{ marginBottom: 16 }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={isPending}
                  onClick={handleCreateLogin}
                >
                  {isPending ? 'Creating…' : 'Create login'}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setCreateLoginModal(null)}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
};
