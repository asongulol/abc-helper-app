import { describe, expect, it, vi } from 'vitest';
import { buildUndoPayload } from '@/lib/time/approvalUndo';

// Stub the edges addHoursDaily touches: auth, the Supabase client, audit, and
// the two time queries. mergeAddedHours stays real — it decides what gets sent
// to the writer, and the whole point of the assertion below is the count that
// comes back from it.
vi.mock('@/server/auth/admin', () => ({
  getCurrentAdmin: async () => ({ isOwner: true, companyIds: [], userId: 'admin-1' }),
}));
vi.mock('@/db/clients/server', () => ({ createServerSupabase: async () => ({}) }));
vi.mock('@/server/audit', () => ({ logEvent: async () => {} }));
// Only imported for the approval path; loading it for real validates Supabase env.
vi.mock('@/server/payroll', () => ({
  syncApprovedTimeToDrafts: async () => ({ workers: 0, closedPeriods: [] }),
}));
vi.mock('@/db/queries/time', async (orig) => ({
  ...(await orig<typeof import('@/db/queries/time')>()),
  fetchExistingDays: async () => [],
  // Contractor's last day is 2026-07-20: the two days past it never land.
  upsertTimeEntries: async (_db: unknown, rows: Array<{ work_date: string }>): Promise<number> =>
    rows.filter((r) => r.work_date > '2026-07-20').length,
}));

const COMPANY = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';

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

describe('addHoursDaily (#87 — a partial post-last-day drop is not clean success)', () => {
  it('reports the dropped day count instead of a bare ok', async () => {
    const { addHoursDaily } = await import('@/server/actions/time');
    // Admin types 07-18 → 07-22 on a contractor whose last day was 07-20.
    const res = await addHoursDaily({
      companyId: COMPANY,
      workerId: WORKER,
      sourceName: 'Departed Dan',
      days: [
        { date: '2026-07-18', hours: 8 },
        { date: '2026-07-19', hours: 8 },
        { date: '2026-07-20', hours: 8 },
        { date: '2026-07-21', hours: 8 },
        { date: '2026-07-22', hours: 8 },
      ],
    });
    // Three days wrote, so this isn't an error — but 16h vanished, and the panel
    // can only warn about it if the count comes back.
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.droppedAfterEnd).toBe(2);
  });

  it('still errors when every day falls after the last day', async () => {
    const { addHoursDaily } = await import('@/server/actions/time');
    const res = await addHoursDaily({
      companyId: COMPANY,
      workerId: WORKER,
      sourceName: 'Departed Dan',
      days: [{ date: '2026-07-21', hours: 8 }],
    });
    expect(res.ok).toBe(false);
  });
});
