'use client';

/**
 * Single import-batch row with a delete button that opens ConfirmDangerModal.
 */

import { Badge, ConfirmDangerModal, useToast } from '@/components/ui';
import type { BatchRow } from '@/db/queries/time';
import { fmtDate, hours as fmtHours } from '@/lib/format';
import { deleteImportBatch } from '@/server/actions/time';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

interface ImportBatchRowProps {
  companyId: string;
  batch: BatchRow;
}

export const ImportBatchRowClient = ({ companyId, batch }: ImportBatchRowProps) => {
  const router = useRouter();
  const { notify } = useToast();
  const [showConfirm, setShowConfirm] = useState(false);
  const [pending, startTransition] = useTransition();

  const totalH = fmtHours(batch.totalSeconds / 3600);
  const approvalLabel = batch.approvalMix.length === 1 ? (batch.approvalMix[0] ?? '—') : 'mixed';

  const approvalTone =
    approvalLabel === 'approved' ? 'good' : approvalLabel === 'rejected' ? 'bad' : 'warn';

  const handleConfirm = () => {
    startTransition(async () => {
      const res = await deleteImportBatch({ companyId, batchId: batch.batchId });
      setShowConfirm(false);
      if (!res.ok) {
        notify(res.error, { type: 'error', persistent: true });
        return;
      }
      notify(
        `Deleted ${res.data?.deleted ?? 0} entr${(res.data?.deleted ?? 0) === 1 ? 'y' : 'ies'} from batch.`,
        { type: 'success' },
      );
      router.refresh();
    });
  };

  return (
    <>
      <tr>
        <td className="card-title">
          <b style={{ fontFamily: 'monospace', fontSize: 11 }}>{batch.batchId.slice(0, 8)}…</b>
        </td>
        <td data-label="Date span">
          {fmtDate(batch.dateMin)} – {fmtDate(batch.dateMax)}
        </td>
        <td data-label="Entries">{batch.entryCount}</td>
        <td data-label="Total hours">{totalH}</td>
        <td data-label="Approval">
          <Badge tone={approvalTone}>{approvalLabel}</Badge>
        </td>
        <td data-label="First name">{batch.firstSourceName}</td>
        <td className="card-action" style={{ textAlign: 'right' }}>
          <button
            type="button"
            className="btn ghost sm"
            style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
            disabled={pending}
            onClick={() => setShowConfirm(true)}
          >
            {pending ? 'Deleting…' : 'Delete'}
          </button>
        </td>
      </tr>

      {showConfirm && (
        <ConfirmDangerModal
          title="Delete import batch?"
          message={`Batch ${batch.batchId.slice(0, 8)}… (${fmtDate(batch.dateMin)} – ${fmtDate(batch.dateMax)}, ${batch.entryCount} entr${batch.entryCount === 1 ? 'y' : 'ies'}, ${totalH}).\n\nThis removes all time entries in this batch. Not reversible — re-import the CSV to restore them.`}
          consequence="Blocked if any entry falls inside a locked or paid pay period."
          confirmWord="DELETE"
          confirmLabel="Delete batch"
          busy={pending}
          onConfirm={handleConfirm}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </>
  );
};
