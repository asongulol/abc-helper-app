/**
 * Tests for contractor-grouping helpers (src/lib/time/grouping.ts).
 */

import { groupByContractor, periodStats } from '@/lib/time/grouping';
import type { TimeEntryRaw } from '@/lib/time/grouping';
import { describe, expect, it } from 'vitest';

const makeEntry = (
  overrides: Partial<TimeEntryRaw> & Pick<TimeEntryRaw, 'sourceName' | 'workDate'>,
): TimeEntryRaw => ({
  id: crypto.randomUUID(),
  workerId: null,
  trackedSeconds: 0,
  ptoSeconds: 0,
  approval: 'pending',
  importBatchId: null,
  ...overrides,
});

describe('groupByContractor', () => {
  it('groups entries by source_name', () => {
    const entries: TimeEntryRaw[] = [
      makeEntry({ sourceName: 'Alice', workDate: '2026-06-01', trackedSeconds: 3600 }),
      makeEntry({ sourceName: 'Alice', workDate: '2026-06-02', trackedSeconds: 7200 }),
      makeEntry({ sourceName: 'Bob', workDate: '2026-06-01', trackedSeconds: 1800 }),
    ];
    const rows = groupByContractor(entries);
    expect(rows).toHaveLength(2);

    const alice = rows.find((r) => r.sourceName === 'Alice');
    expect(alice?.trackedSeconds).toBe(10800);
    expect(alice?.daysWorked).toBe(2);

    const bob = rows.find((r) => r.sourceName === 'Bob');
    expect(bob?.trackedSeconds).toBe(1800);
  });

  it('computes totalSeconds as tracked + pto', () => {
    const entries: TimeEntryRaw[] = [
      makeEntry({
        sourceName: 'Alice',
        workDate: '2026-06-01',
        trackedSeconds: 3600,
        ptoSeconds: 1800,
      }),
    ];
    const [row] = groupByContractor(entries);
    expect(row?.totalSeconds).toBe(5400);
  });

  it('reports mixed when statuses differ', () => {
    const entries: TimeEntryRaw[] = [
      makeEntry({ sourceName: 'Alice', workDate: '2026-06-01', approval: 'pending' }),
      makeEntry({ sourceName: 'Alice', workDate: '2026-06-02', approval: 'approved' }),
    ];
    const [row] = groupByContractor(entries);
    expect(row?.approvalStatus).toBe('mixed');
  });

  it('reports single status when all are the same', () => {
    const entries: TimeEntryRaw[] = [
      makeEntry({ sourceName: 'Alice', workDate: '2026-06-01', approval: 'approved' }),
      makeEntry({ sourceName: 'Alice', workDate: '2026-06-02', approval: 'approved' }),
    ];
    const [row] = groupByContractor(entries);
    expect(row?.approvalStatus).toBe('approved');
  });

  it('returns empty array for no entries', () => {
    expect(groupByContractor([])).toEqual([]);
  });
});

describe('periodStats', () => {
  it('counts days and weekdays for Jun 1–15 2026', () => {
    const stats = periodStats('2026-06-01', '2026-06-15');
    expect(stats.periodDays).toBe(15);
    expect(stats.workingDays).toBeGreaterThan(0);
    expect(stats.workingDays).toBeLessThanOrEqual(11);
  });
});
