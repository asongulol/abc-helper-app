'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  Badge,
  type BadgeTone,
  ConfirmDangerModal,
  Modal,
  Spinner,
  useToast,
} from '@/components/ui';
import type { PullRecipientRow, PullRecipientStatus } from '@/lib/wise/recipient-match';
import { type PullRecipientsResult, wisePullRecipientIds } from '@/server/actions/wise';

interface Props {
  onClose: () => void;
}

const STATUS: Record<PullRecipientStatus, { tone: BadgeTone; label: string }> = {
  'already-linked': { tone: 'good', label: 'already linked' },
  matched: { tone: 'neutral', label: 'proposed' },
  unmatched: { tone: 'warn', label: 'unmatched' },
};

/**
 * RP-56: a name match is a PROPOSAL — these are the rows the owner may confirm.
 * Rows written by this call (`linked`) drop out so a second confirm can't
 * re-submit them, and a proposal with no contractor is never sendable.
 */
export const linkableRecipientIds = (rows: PullRecipientRow[]): number[] =>
  rows.filter((r) => r.status === 'matched' && r.contractor && !r.linked).map((r) => r.recipientId);

/**
 * "Pull recipient IDs from Wise" (manifest 21) — two steps. The pull previews
 * matches (read-only, any admin); linking a proposed match writes the numeric
 * recipient ID onto the contractor and is owner-only, so it goes through an
 * explicit confirm (RP-56). No bank details, no money.
 */
export const PullWiseRecipientsModal = ({ onClose }: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<PullRecipientsResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  // No ids = preview (the action writes nothing); ids = the confirmed links.
  const run = (linkIds?: number[]) =>
    startTransition(async () => {
      const res = await wisePullRecipientIds(linkIds);
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      const d = res.data;
      setResult(d);
      notify(
        linkIds
          ? `Linked ${d.linked} recipient(s) · ${d.alreadyLinked} already linked · ${d.unmatched} unmatched.`
          : `Preview only — nothing stored. ${d.matched} proposed · ${d.alreadyLinked} already linked · ${d.unmatched} unmatched.`,
        { type: 'success' },
      );
      if (d.linked > 0) router.refresh();
    });

  const linkable = result ? linkableRecipientIds(result.rows) : [];

  return (
    <Modal title="Pull recipient IDs from Wise" onClose={onClose} maxWidth={760}>
      <p className="sub">
        Lists your saved Wise recipients and matches each to a contractor (by stored Wise ID first,
        then name). The pull is a <b>preview</b>: name matches are <b>proposals</b> and nothing is
        stored until you confirm them below. Doesn&apos;t pull bank details or the batch-CSV UUID.
        No money moves.
      </p>

      {result && (
        <>
          <div className="banner" style={{ margin: '12px 0' }}>
            {result.total} recipient(s) · {result.alreadyLinked} already linked · {linkable.length}{' '}
            proposed · {result.unmatched} unmatched
            {result.linked > 0 ? ` · ${result.linked} linked just now` : ''}.
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
                        {row.linked ? (
                          <Badge tone="good">linked</Badge>
                        ) : (
                          <Badge tone={s.tone}>{s.label}</Badge>
                        )}
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
        <button
          type="button"
          className={linkable.length > 0 ? 'btn ghost' : 'btn'}
          onClick={() => run()}
          disabled={isPending}
        >
          {isPending ? (
            <>
              <Spinner /> Pulling…
            </>
          ) : result ? (
            'Refresh preview'
          ) : (
            'Preview matches'
          )}
        </button>
        {linkable.length > 0 && (
          <button
            type="button"
            className="btn"
            onClick={() => setConfirming(true)}
            disabled={isPending}
          >
            Link {linkable.length} matched
          </button>
        )}
      </div>

      {confirming && (
        <ConfirmDangerModal
          title={`Link ${linkable.length} proposed match(es)?`}
          message={`Stores the Wise recipient ID on ${linkable.length} contractor(s) — the ones shown as "proposed" above.`}
          consequence="These are name matches only. The recipient ID decides where that contractor's pay is sent, so a wrong match pays someone else's bank account. Owner only."
          confirmWord="LINK"
          confirmLabel={`Link ${linkable.length}`}
          busy={isPending}
          onConfirm={() => {
            setConfirming(false);
            run(linkable);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </Modal>
  );
};
