/**
 * Pure resolver for one Wise draft row — picks the recipient + amount to draft,
 * honoring optional per-row overrides from the UI. No override → the worker's
 * saved default recipient and the locked net (identical to the prior behaviour).
 * Pure (no DB / server deps) so it is unit-testable.
 */

export interface DraftOverride {
  recipientId?: number | undefined;
  amountPhp?: number | undefined;
}

export const resolveDraftRow = (
  row: { net_php: number | null; workers?: { wise_recipient_id?: number | null } | null },
  override?: DraftOverride,
): { recipientId: number | null; amountPhp: number } => ({
  recipientId: override?.recipientId ?? row.workers?.wise_recipient_id ?? null,
  amountPhp: override?.amountPhp ?? Number(row.net_php ?? 0),
});

/** A payment row joined with its worker's payee identity (as selected by wiseBatch). */
export interface DraftPaymentRow {
  id: string;
  net_php: number | null;
  workers?: {
    wise_recipient_id?: number | null;
    /** jsonb [{ id, label }] — the worker's saved recipient list. */
    wise_recipients?: unknown;
    first_name?: string | null;
    last_name?: string | null;
  } | null;
}

/** Recipient ids this worker may be paid at: the saved list + the current default. */
const ownRecipientIds = (worker: DraftPaymentRow['workers']): number[] => {
  const list = Array.isArray(worker?.wise_recipients) ? worker.wise_recipients : [];
  const ids = list
    .map((r) => Number((r as { id?: unknown } | null)?.id))
    .filter((n) => Number.isInteger(n));
  if (worker?.wise_recipient_id != null) ids.push(Number(worker.wise_recipient_id));
  return ids;
};

/**
 * RP-54: per-row `recipientId` overrides that point at a recipient the worker
 * does NOT own. A recipient IS a bank account, so a tampered/stale override
 * drafts that worker's net into someone else's account — and the matcher
 * (recipient + amount) still calls the result reconciled.
 *
 * Rows whose payment id isn't in `rows` are ignored: the draft layer already
 * skips payments it can't load.
 */
export const foreignRecipientRows = (
  items: { paymentId: string; recipientId?: number | undefined }[],
  rows: DraftPaymentRow[],
): { paymentId: string; recipientId: number; name: string }[] => {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bad: { paymentId: string; recipientId: number; name: string }[] = [];
  for (const item of items) {
    if (item.recipientId == null) continue; // no override → the worker's own default
    const row = byId.get(item.paymentId);
    if (!row) continue;
    if (ownRecipientIds(row.workers).includes(item.recipientId)) continue;
    bad.push({
      paymentId: item.paymentId,
      recipientId: item.recipientId,
      name:
        [row.workers?.first_name, row.workers?.last_name].filter(Boolean).join(' ') ||
        'that contractor',
    });
  }
  return bad;
};
