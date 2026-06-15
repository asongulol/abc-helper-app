'use client';

import { Badge } from '@/components/ui';
import { Spinner } from '@/components/ui';
import { useToast } from '@/components/ui';
import { wiseMatch, wisePoll } from '@/server/actions/wise';
import { useState, useTransition } from 'react';

type PendingAction = 'backfill' | 'scan' | null;

/**
 * Wise reconciliation card (manifest 14, lower panel) — admin-only maintenance
 * tools, split into three sub-blocks: a one-time transfer-ID backfill across all
 * paid periods, an email cross-check (legacy parity TODO, rendered disabled), and
 * a cross-system drift scan over Wise + Hubstaff. Backfill/Scan call the wise
 * server actions; "Check emails" has no wired action yet.
 */
export const WiseReconCard = () => {
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [pending, setPending] = useState<PendingAction>(null);

  const handleBackfill = () => {
    setPending('backfill');
    startTransition(async () => {
      try {
        const res = await wiseMatch({});
        if (res.ok) {
          toast.notify(`Matched ${res.data.matched} payment(s).`, { type: 'success' });
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Backfill failed.', { type: 'error' });
      } finally {
        setPending(null);
      }
    });
  };

  const handleScan = () => {
    setPending('scan');
    startTransition(async () => {
      try {
        const res = await wisePoll();
        if (res.ok) {
          toast.notify(`Updated ${res.data.updated} of ${res.data.checked} checked.`, {
            type: 'success',
          });
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Scan failed.', { type: 'error' });
      } finally {
        setPending(null);
      }
    });
  };

  return (
    <div className="card">
      <h3>
        Wise reconciliation <Badge tone="neutral">admin</Badge>
      </h3>
      <p className="sub">
        One-time cleanup: scans every paid Wise payment that has no <code>wise_transfer_id</code>{' '}
        stored, pulls Wise's transfer history, and links each DB row to its real Wise transfer by
        recipient + amount + date. Read-mostly: writes only the transfer ID. Never changes amounts.
        Variances and ambiguous matches are surfaced for review.
      </p>
      <div className="actions">
        <button type="button" className="btn" onClick={handleBackfill} disabled={pending !== null}>
          {pending === 'backfill' && <Spinner />} Backfill all paid periods
        </button>
      </div>

      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <h4 style={{ margin: '0 0 4px' }}>Email cross-check</h4>
        <p className="sub">
          Compares the email on each contractor against the email Wise has on their linked
          recipient. Surfaces mismatches for manual fix. <b>Partial signal:</b> only catches
          mismatches where Wise actually has an email on the recipient (many PHP bank recipients
          don't).
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn ghost"
            disabled
            title="No email-check action is wired yet (legacy parity TODO)."
          >
            Check emails
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <h4 style={{ margin: '0 0 4px' }}>Cross-system drift (Wise + Hubstaff)</h4>
        <p className="sub">
          Scans every contractor with a Wise recipient or Hubstaff user and lists where the external
          system disagrees with the DB on name or email. Click a name to open the profile and fix it
          there.
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn ghost"
            onClick={handleScan}
            disabled={pending !== null}
          >
            {pending === 'scan' && <Spinner />} Scan all
          </button>
        </div>
      </div>
    </div>
  );
};
