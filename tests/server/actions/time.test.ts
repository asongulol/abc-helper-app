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
// editContractorDays: two known entries (one in the Aug 16–31 period, one
// past it), a switchable set of closed periods, and a record of what was written.
const dayState = vi.hoisted(() => ({
  written: [] as Array<{ id: string; trackedSeconds: number }>,
  closed: [] as Array<{
    id: string;
    periodStart: string;
    periodEnd: string;
    state: 'locked' | 'paid';
    lockedAt: string | null;
  }>,
}));
const IN_ID = '33333333-3333-4333-8333-333333333333';
const OUT_ID = '44444444-4444-4444-8444-444444444444';

vi.mock('@/db/queries/time', async (orig) => ({
  ...(await orig<typeof import('@/db/queries/time')>()),
  fetchExistingDays: async () => [],
  fetchEntryDates: async (_db: unknown, _co: string, ids: string[]) =>
    ids.map((id) => ({
      id,
      workerId: '22222222-2222-4222-8222-222222222222',
      workDate: id === '44444444-4444-4444-8444-444444444444' ? '2026-09-02' : '2026-08-24',
      approval: 'approved',
      approvedAt: '2026-08-25T00:00:00Z',
    })),
  fetchLockedPeriodsInRange: async () => dayState.closed,
  updateTrackedSeconds: async (
    _db: unknown,
    _co: string,
    updates: Array<{ id: string; trackedSeconds: number }>,
  ) => {
    dayState.written.push(...updates);
  },
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

describe('editContractorDays (the way back from a mistaken Add hours)', () => {
  const period = { periodStart: '2026-08-16', periodEnd: '2026-08-31' };

  it('rewrites one day and leaves the rest alone', async () => {
    dayState.written.length = 0;
    dayState.closed = [];
    const { editContractorDays } = await import('@/server/actions/time');
    const res = await editContractorDays({
      companyId: COMPANY,
      sourceName: 'Trisha Tagubaras',
      days: [{ id: IN_ID, hours: 8.4 }],
      ...period,
    });
    expect(res.ok).toBe(true);
    expect(dayState.written).toEqual([{ id: IN_ID, trackedSeconds: 30240 }]);
  });

  it('refuses a day outside the period being viewed', async () => {
    dayState.written.length = 0;
    dayState.closed = [];
    const { editContractorDays } = await import('@/server/actions/time');
    const res = await editContractorDays({
      companyId: COMPANY,
      sourceName: 'Trisha Tagubaras',
      days: [{ id: OUT_ID, hours: 0 }],
      ...period,
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('2026-09-02');
    expect(dayState.written).toEqual([]);
  });

  it('refuses a day a locked run has already paid', async () => {
    dayState.written.length = 0;
    dayState.closed = [
      {
        id: 'p',
        periodStart: '2026-08-16',
        periodEnd: '2026-08-31',
        state: 'paid',
        lockedAt: '2026-08-30T00:00:00Z', // approved 08-25, before the lock → paid
      },
    ];
    const { editContractorDays } = await import('@/server/actions/time');
    const res = await editContractorDays({
      companyId: COMPANY,
      sourceName: 'Trisha Tagubaras',
      days: [{ id: IN_ID, hours: 8.4 }],
      ...period,
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('locked or paid');
    expect(dayState.written).toEqual([]);
  });
});
