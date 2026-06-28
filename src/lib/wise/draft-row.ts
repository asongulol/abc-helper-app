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
