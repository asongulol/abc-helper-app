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
  snapshot: ApprovalUndoEntry[],
  newStatus: 'approved' | 'rejected',
): ApprovalUndoEntry[] => snapshot.filter((e) => e.approval !== newStatus);
