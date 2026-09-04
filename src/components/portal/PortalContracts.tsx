'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge, type BadgeTone, useToast } from '@/components/ui';
import type { ContractVersion, ContractVersionStatus } from '@/db/queries/contracts';
import { fmtDate } from '@/lib/format';
import { signContractVersion } from '@/server/actions/contracts';
import { type SignInput, SignModal } from './SignModal';

/** The original (version 1) agreement, read from the legacy rows. */
export type LegacyContract = {
  signedAt: string | null;
  countersignedAt: string | null;
  countersignedName: string | null;
};

interface Props {
  versions: ContractVersion[];
  legacy: LegacyContract | null;
}

const LABEL: Record<ContractVersionStatus, string> = {
  draft: 'Draft',
  sent: 'Awaiting your signature',
  signed: 'Awaiting countersign',
  active: 'Current',
  superseded: 'Superseded',
  ended: 'Ended',
  void: 'Withdrawn',
};
const TONE: Record<ContractVersionStatus, BadgeTone> = {
  draft: 'neutral',
  sent: 'warn',
  signed: 'warn',
  active: 'good',
  superseded: 'neutral',
  ended: 'neutral',
  void: 'neutral',
};

/**
 * The contractor's contract history — the version out for signature first,
 * then every version they have seen, the original agreement last. Read-only
 * apart from signing. Owner rule: nothing here ever shows an exchange rate.
 */
export const PortalContracts = ({ versions, legacy }: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [signing, setSigning] = useState<ContractVersion | null>(null);

  // Drafts are the admin's business until they are sent.
  const shown = versions.filter((v) => v.status !== 'draft');
  const pending = shown.find((v) => v.status === 'sent') ?? null;
  const hasActive = shown.some((v) => v.status === 'active');

  const sign = (v: ContractVersion, sig: SignInput) => {
    startTransition(async () => {
      const res = await signContractVersion({ versionId: v.id, ...sig });
      if (res.ok) {
        notify(`Version ${v.version} signed — thank you. An admin will countersign it.`, {
          type: 'success',
        });
        setSigning(null);
        router.refresh();
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };

  return (
    <div>
      {pending && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--warn, #b45309)' }}>
          <Badge tone="warn">Action needed</Badge>
          <h2 style={{ marginTop: 8 }}>A new agreement is ready to sign</h2>
          <p className="sub">
            Version {pending.version} of your Independent Contractor Agreement takes effect on{' '}
            {fmtDate(pending.effectiveFrom)}. Read it through to the end, then sign. Your current
            agreement stays in force until this one is countersigned.
          </p>
          <button
            type="button"
            className="btn"
            style={{ marginTop: 8 }}
            disabled={isPending}
            onClick={() => setSigning(pending)}
          >
            Review &amp; sign
          </button>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Contracts</h2>
        {shown.length === 0 && !legacy ? (
          <p className="sub">No signed agreement on file yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Effective</th>
                  <th>Signed</th>
                  <th>Countersigned</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((v) => (
                  <tr key={v.id} style={v.status === 'active' ? { fontWeight: 600 } : undefined}>
                    <td>v{v.version}</td>
                    <td>
                      <Badge tone={TONE[v.status]}>{LABEL[v.status]}</Badge>
                    </td>
                    <td>
                      {fmtDate(v.effectiveFrom)}
                      {v.endedOn ? ` → ${fmtDate(v.endedOn)}` : ''}
                    </td>
                    <td>{v.signedAt ? fmtDate(v.signedAt) : '—'}</td>
                    <td>
                      {v.countersignedAt
                        ? `${fmtDate(v.countersignedAt)}${v.countersignedName ? ` · ${v.countersignedName}` : ''}`
                        : '—'}
                    </td>
                    <td>
                      {v.renderedBody && (
                        <a href={`/portal/contracts/${v.id}/print`} target="_blank" rel="noopener">
                          View
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
                {legacy && (
                  <tr style={hasActive ? undefined : { fontWeight: 600 }}>
                    <td>v1</td>
                    <td>
                      <Badge tone={hasActive ? 'neutral' : 'good'}>
                        {hasActive ? 'Superseded' : 'Current'}
                      </Badge>
                      <span className="sub" style={{ fontSize: 11, marginLeft: 6 }}>
                        original agreement
                      </span>
                    </td>
                    <td>—</td>
                    <td>{legacy.signedAt ? fmtDate(legacy.signedAt) : '—'}</td>
                    <td>
                      {legacy.countersignedAt
                        ? `${fmtDate(legacy.countersignedAt)}${legacy.countersignedName ? ` · ${legacy.countersignedName}` : ''}`
                        : '—'}
                    </td>
                    <td>
                      {legacy.signedAt && (
                        <a
                          href="/portal/onboarding/ic_agreement/print"
                          target="_blank"
                          rel="noopener"
                        >
                          View
                        </a>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {signing && (
        <SignModal
          title={`Sign — Independent Contractor Agreement, version ${signing.version}`}
          body={signing.renderedBody ?? ''}
          busy={isPending}
          onClose={() => setSigning(null)}
          onSign={(sig) => sign(signing, sig)}
        />
      )}
    </div>
  );
};
