'use client';

import { useId, useState } from 'react';
import { Modal } from '@/components/ui/Modal';

export interface EndEngagementModalProps {
  /** Who is leaving — shown so a mis-clicked row is obvious before confirming. */
  name: string;
  /** Set for a single assignment; omitted for a full termination. */
  companyName?: string | undefined;
  busy?: boolean | undefined;
  onConfirm: (args: { lastDay: string; reason: string }) => void;
  onCancel: () => void;
}

/** Today in the browser's own timezone — `toISOString()` would shift the date
 *  back a day for anyone west of UTC, which is everyone using this app. */
const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * The one dialog behind both departure flows — terminate (every engagement) and
 * end assignment (one company). They differ only in wording and blast radius,
 * so they share a form: last day + optional reason.
 *
 * The last day matters beyond the audit trail — it end-dates rates and coverage
 * targets, and stops time importing past it (upsertTimeEntries).
 */
export const EndEngagementModal = ({
  name,
  companyName,
  busy = false,
  onConfirm,
  onCancel,
}: EndEngagementModalProps) => {
  const [lastDay, setLastDay] = useState(todayIso);
  const [reason, setReason] = useState('');
  const dateId = useId();
  const reasonId = useId();

  const isTermination = companyName === undefined;
  const title = isTermination ? 'Terminate contractor' : 'End assignment';

  return (
    <Modal title={title} onClose={onCancel} maxWidth={460}>
      <p style={{ marginTop: 0 }}>
        {isTermination ? (
          <>
            End <strong>every</strong> engagement for <strong>{name}</strong>.
          </>
        ) : (
          <>
            End <strong>{name}</strong>&rsquo;s assignment to <strong>{companyName}</strong>.
          </>
        )}
      </p>

      <div className="field">
        <label htmlFor={dateId}>Last day</label>
        <input
          id={dateId}
          type="date"
          value={lastDay}
          max={todayIso()}
          onChange={(e) => setLastDay(e.target.value)}
          disabled={busy}
          required
        />
        <p className="sub" style={{ margin: '4px 0 0' }}>
          Rates and coverage targets close on this date.
        </p>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor={reasonId}>Reason (optional)</label>
        <input
          id={reasonId}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. resigned, contract ended"
          disabled={busy}
        />
      </div>

      <p className="warn" style={{ marginTop: 12 }}>
        {isTermination
          ? 'Work already tracked is still payable — pay it off-cycle or on the next scheduled period. Portal access stays open until their final pay lands.'
          : 'If this is their only active assignment they become inactive (between assignments), not terminated.'}
      </p>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={busy || !lastDay}
          onClick={() => onConfirm({ lastDay, reason: reason.trim() })}
        >
          {isTermination ? 'Terminate' : 'End assignment'}
        </button>
      </div>
    </Modal>
  );
};
