/**
 * Pure helper for building the undo payload for approve/reject operations.
 * No I/O — takes already-fetched data as input.
 */

export interface ApprovalUndoEntry {
  id: string;
  approval: 'pending' | 'approved' | 'rejected';
}

/**
 * Given a snapshot of prior approval values and the new status that was just applied,
 * return only the entries that were NOT already at the new status — i.e. the ones
 * that actually changed and can be reverted.
 */
export const buildUndoPayload = (
  snapshot: readonly ApprovalUndoEntry[],
  newStatus: 'approved' | 'rejected',
): ApprovalUndoEntry[] =>
  snapshot
    .filter((e) => e.approval !== newStatus)
    // Projected, not passed through: the snapshot also carries worker/day for the
    // Calculate transfer, and this payload is posted straight back by the client.
    .map(({ id, approval }) => ({ id, approval }));
