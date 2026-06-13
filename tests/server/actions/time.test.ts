import { buildUndoPayload } from '@/lib/time/approvalUndo';
import { describe, expect, it } from 'vitest';

describe('buildUndoPayload', () => {
  it('returns only entries whose prior approval differs from the new status', () => {
    const snapshot = [
      { id: 'a', approval: 'pending' as const },
      { id: 'b', approval: 'approved' as const },
      { id: 'c', approval: 'rejected' as const },
    ];
    // Approving: undo payload should not include rows that were already 'approved'.
    const result = buildUndoPayload(snapshot, 'approved');
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.id).sort()).toEqual(['a', 'c']);
  });

  it('returns all entries when none match the new status', () => {
    const snapshot = [
      { id: 'x', approval: 'pending' as const },
      { id: 'y', approval: 'rejected' as const },
    ];
    const result = buildUndoPayload(snapshot, 'approved');
    expect(result).toHaveLength(2);
  });

  it('returns empty array when all entries were already at the new status', () => {
    const snapshot = [
      { id: '1', approval: 'rejected' as const },
      { id: '2', approval: 'rejected' as const },
    ];
    const result = buildUndoPayload(snapshot, 'rejected');
    expect(result).toHaveLength(0);
  });

  it('handles an empty snapshot', () => {
    expect(buildUndoPayload([], 'approved')).toEqual([]);
  });

  it('preserves the original approval value on each returned entry', () => {
    const snapshot = [{ id: 'z', approval: 'pending' as const }];
    const result = buildUndoPayload(snapshot, 'approved');
    expect(result[0]?.approval).toBe('pending');
  });
});
