'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge, type BadgeTone, Modal, Spinner, useToast } from '@/components/ui';
import {
  type PullRecipientStatus,
  type PullRecipientsResult,
  wisePullRecipientIds,
} from '@/server/actions/wise';

interface Props {
  onClose: () => void;
}

const STATUS: Record<PullRecipientStatus, { tone: BadgeTone; label: string }> = {
  'already-linked': { tone: 'good', label: 'already linked' },
  matched: { tone: 'good', label: 'matched' },
  unmatched: { tone: 'warn', label: 'unmatched' },
};

/**
 * "Pull recipient IDs from Wise" (manifest 21) — read-only. Lists saved Wise
 * recipients, matches each to a contractor (by stored Wise ID, then name), and
 * shows the per-recipient table (legacy parity). No bank details, no money.
 */
export const PullWiseRecipientsModal = ({ onClose }: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<PullRecipientsResult | null>(null);

  const handlePull = () => {
    startTransition(async () => {
      const res = await wisePullRecipientIds();
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      setResult(res.data);
      notify(
        `${res.data.matched} newly matched · ${res.data.alreadyLinked} already linked · ${res.data.unmatched} unmatched.`,
        { type: 'success' },
      );
      router.refresh();
    });
  };

  return (
    <Modal title="Pull recipient IDs from Wise" onClose={onClose} maxWidth={760}>
      <p className="sub">
        Read-only. Lists your saved Wise recipients and matches each to a contractor (by stored Wise
        ID first, then name), then stores the numeric <b>recipient ID</b> on the matched contractor.
        Doesn't pull bank details or the batch-CSV UUID. No money moves.
      </p>

      {result && (
        <>
          <div className="banner" style={{ margin: '12px 0' }}>
            {result.total} recipient(s) · {result.alreadyLinked} already linked · {result.matched}{' '}
            newly matched · {result.unmatched} unmatched.
          </div>
          <div className="table-scroll" style={{ maxHeight: 380 }}>
            <table>
              <thead>
                <tr>
                  <th>Wise recipient</th>
                  <th>Currency</th>
                  <th>Account</th>
                  <th>Matched contractor</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => {
                  const s = STATUS[row.status];
                  return (
                    <tr key={row.recipientId}>
                      <td>
                        <b>{row.name}</b> <span className="muted">#{row.recipientId}</span>
                      </td>
                      <td>{row.currency || '—'}</td>
                      <td>{row.account || '—'}</td>
                      <td>{row.contractor?.name ?? <span className="muted">— no match —</span>}</td>
                      <td>
                        <Badge tone={s.tone}>{s.label}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="actions">
        <button type="button" className="btn ghost" onClick={onClose} disabled={isPending}>
          Close
        </button>
        <button type="button" className="btn" onClick={handlePull} disabled={isPending}>
          {isPending ? (
            <>
              <Spinner /> Pulling…
            </>
          ) : (
            'Pull IDs from Wise'
          )}
        </button>
      </div>
    </Modal>
  );
};
