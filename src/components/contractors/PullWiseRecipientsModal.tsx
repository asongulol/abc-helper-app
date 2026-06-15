'use client';

import { Modal, Spinner, useToast } from '@/components/ui';
import { wisePullRecipientIds } from '@/server/actions/wise';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

interface Props {
  onClose: () => void;
}

/**
 * "Pull recipient IDs from Wise" (manifest 21) — read-only. Lists saved Wise
 * recipients, matches each to a contractor by name, and stores the numeric
 * recipient id on the matched contractor. No bank details, no money movement.
 */
export const PullWiseRecipientsModal = ({ onClose }: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ total: number; matched: number; updated: number } | null>(
    null,
  );

  const handlePull = () => {
    startTransition(async () => {
      const res = await wisePullRecipientIds();
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      setResult(res.data);
      notify(`Matched ${res.data.matched} of ${res.data.total} recipients.`, { type: 'success' });
      router.refresh();
    });
  };

  return (
    <Modal title="Pull recipient IDs from Wise" onClose={onClose} maxWidth={460}>
      <p className="sub">
        Read-only. Lists your saved Wise recipients and matches each to a contractor (by stored Wise
        ID first, then name), then stores the numeric <b>recipient ID</b> on the matched contractor.
        Doesn't pull bank details or the batch-CSV UUID. No money moves.
      </p>

      {result && (
        <div className="banner" style={{ margin: '12px 0' }}>
          {result.total} recipient(s) · {result.matched} matched · {result.updated} updated.
        </div>
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
