'use client';

/**
 * WisePayoutsPanel — "3 · Automatic Wise API draft" (port of legacy WisePayouts).
 *
 * Per-Wise-contractor row with an editable amount + recipient dropdown and an
 * include/exclude checkbox, then "Create Wise batch (N)" drafts them in one Wise
 * batch group via the API. DRAFTS ONLY — no money moves; the owner reviews,
 * completes, and funds the batch in Wise. (Real-money funding / "Enable API
 * payouts" are intentionally not built here.)
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import type { ProcessPayment } from '@/db/queries/payroll';
import { peso } from '@/lib/format';
import { wiseBatch } from '@/server/actions/wise';

interface WisePayoutsPanelProps {
  periodEnd: string;
  payments: ProcessPayment[];
  isOwner: boolean;
  onDrafted: () => void | Promise<void>;
}

type Row = {
  paymentId: string;
  workerId: string;
  name: string;
  amount: string;
  recipientId: number | null;
  recipients: { id: number; label: string }[];
  recipientUuid: string | null;
  include: boolean;
  transferId: string | null;
};

const toRows = (payments: ProcessPayment[]): Row[] =>
  payments
    .filter((p) => p.payoutMethod === 'wise')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => {
      const def = p.wiseRecipientId ?? p.wiseRecipients[0]?.id ?? null;
      return {
        paymentId: p.paymentId,
        workerId: p.workerId,
        name: p.name,
        amount: String(p.netPhp ?? 0),
        recipientId: def,
        recipients: p.wiseRecipients,
        recipientUuid: p.wiseRecipientUuid,
        include: !!def && !p.wiseTransferId,
        transferId: p.wiseTransferId,
      };
    });

export function WisePayoutsPanel({
  periodEnd,
  payments,
  isOwner,
  onDrafted,
}: WisePayoutsPanelProps) {
  const { notify } = useToast();
  const [rows, setRows] = useState<Row[]>(() => toRows(payments));
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);

  // Re-derive rows only when the underlying Wise set or its draft state changes
  // (e.g. after a batch refreshes the parent) — NOT on every keystroke edit.
  const sig = useMemo(
    () =>
      payments
        .filter((p) => p.payoutMethod === 'wise')
        .map((p) => `${p.paymentId}:${p.wiseTransferId ?? ''}`)
        .join('|'),
    [payments],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: sig is the derived trigger; depending on `payments` would clobber edits each render.
  useEffect(() => {
    setRows(toRows(payments));
    setArmed(false);
  }, [sig]);

  const setRow = (paymentId: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.paymentId === paymentId ? { ...r, ...patch } : r)));

  const selectable = rows.filter((r) => !r.transferId);
  const allOn = selectable.length > 0 && selectable.every((r) => r.include);
  const setAll = (include: boolean) =>
    setRows((prev) => prev.map((r) => (r.transferId ? r : { ...r, include })));

  const selected = rows.filter(
    (r) => r.include && r.recipientId && Number(r.amount) > 0 && !r.transferId,
  );
  const total = selected.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  const createBatch = async () => {
    setBusy(true);
    setArmed(false);
    try {
      const r = await wiseBatch(
        selected.map((row) => ({
          paymentId: row.paymentId,
          recipientId: row.recipientId ?? undefined,
          amountPhp: Number(row.amount) || undefined,
        })),
        `Payroll ${periodEnd}`,
      );
      if (!r.ok) {
        notify(r.error, { type: 'error', persistent: true });
        return;
      }
      const drafted = r.data.results.filter((x) => x.transferId != null).length;
      const failed = r.data.results.filter((x) => x.error != null).length;
      notify(
        `Created a Wise batch with ${drafted} draft transfer(s)${failed ? `, ${failed} failed` : ''}. No money has moved — review, complete, and FUND the batch in Wise (group ${r.data.batchGroupId}).`,
        { type: failed ? 'error' : 'success', persistent: failed > 0 },
      );
      await onDrafted();
    } finally {
      setBusy(false);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="empty">
        No Wise contractors in this period. Set a contractor&apos;s payout method to Wise to draft
        via the API.
      </div>
    );
  }

  return (
    <div>
      <p className="sub" style={{ marginTop: 4 }}>
        {selected.length} selected · total to batch <b>{peso(total)}</b>
      </p>
      <div className="table-scroll">
        <table aria-label="Wise payouts">
          <thead>
            <tr>
              <th scope="col">
                <label
                  style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontWeight: 600 }}
                >
                  <input
                    type="checkbox"
                    checked={allOn}
                    onChange={(e) => setAll(e.target.checked)}
                    disabled={!selectable.length}
                  />{' '}
                  All
                </label>
              </th>
              <th scope="col">Contractor</th>
              <th scope="col">Amount ₱</th>
              <th scope="col">Wise recipient</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.paymentId} style={r.transferId ? { opacity: 0.6 } : undefined}>
                <td className="card-action">
                  <input
                    type="checkbox"
                    aria-label={`Include ${r.name}`}
                    checked={r.include && !r.transferId}
                    disabled={!!r.transferId}
                    onChange={(e) => setRow(r.paymentId, { include: e.target.checked })}
                  />
                </td>
                <td className="card-title">
                  <b>{r.name}</b>
                </td>
                <td data-label="Amount ₱">
                  <input
                    type="number"
                    step="0.01"
                    aria-label={`Amount for ${r.name}`}
                    value={r.amount}
                    disabled={!!r.transferId}
                    onChange={(e) => setRow(r.paymentId, { amount: e.target.value })}
                    style={{ width: 100, padding: '3px 6px', fontSize: 13 }}
                  />
                </td>
                <td data-label="Wise recipient">
                  {r.transferId ? (
                    <span className="muted">#{r.recipientId}</span>
                  ) : r.recipients.length > 0 ? (
                    <select
                      aria-label={`Wise recipient for ${r.name}`}
                      value={r.recipientId ?? ''}
                      onChange={(e) => setRow(r.paymentId, { recipientId: Number(e.target.value) })}
                      style={{ padding: '3px 6px', fontSize: 13 }}
                    >
                      {r.recipients.map((rec) => (
                        <option key={rec.id} value={rec.id}>
                          {rec.label} (#{rec.id})
                        </option>
                      ))}
                    </select>
                  ) : r.recipientId ? (
                    <span className="muted">#{r.recipientId}</span>
                  ) : r.recipientUuid ? (
                    <span
                      className="muted"
                      style={{ fontStyle: 'italic' }}
                      title="Paid via Wise Tag. The API draft needs a bank-account recipient — include this contractor in the Manual Wise batch file instead (it uses the stored UUID)."
                    >
                      Wisetag — use Manual CSV
                    </span>
                  ) : (
                    <Link
                      href={`/contractors/${r.workerId}`}
                      style={{ color: 'var(--warn)', textDecoration: 'underline' }}
                    >
                      add recipient on profile
                    </Link>
                  )}
                </td>
                <td data-label="Status" className="card-action">
                  {r.transferId ? (
                    // navy (not green) — drafted still needs funding in Wise
                    <span className="pill info" title="Draft created — fund it in Wise">
                      drafted
                    </span>
                  ) : (
                    <Badge tone="neutral">ready</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      >
        {!isOwner ? (
          <span className="muted">Only the owner can create Wise drafts.</span>
        ) : selected.length === 0 ? (
          <span className="muted">Nothing selected to batch.</span>
        ) : armed ? (
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13 }}>
              Create a Wise batch of {selected.length} transfer(s), {peso(total)}? (no money moves)
            </span>
            <button type="button" className="btn" disabled={busy} onClick={createBatch}>
              {busy ? 'Creating…' : 'Confirm batch'}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => setArmed(false)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={() => setArmed(true)}>
            Create Wise batch ({selected.length})
          </button>
        )}
      </div>
    </div>
  );
}
