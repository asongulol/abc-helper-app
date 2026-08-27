import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { findOrCreateOffCycleBatch } from '@/db/queries/payroll';
import type { Database } from '@/db/types';

/** Scripted stub in the workers.test.ts mould: each lookup's maybeSingle() pops
 *  the next queued row, the insert resolves with the configured result. */
type Row = { id: string; period_start: string; period_end: string };

type Chain = {
  eq: () => Chain;
  order: () => Chain;
  limit: () => Chain;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
};

const stubDb = (script: {
  selects: (Row | null)[];
  insert?: { data?: Row; error?: { message: string; code?: string } };
}) => {
  const inserts: Record<string, unknown>[] = [];
  let selectCalls = 0;
  const db = {
    from: () => ({
      select: () => {
        const chain: Chain = {
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => {
            const data = script.selects[selectCalls] ?? null;
            selectCalls += 1;
            return Promise.resolve({ data, error: null });
          },
        };
        return chain;
      },
      insert: (payload: Record<string, unknown>) => {
        inserts.push(payload);
        return {
          select: () => ({
            single: () =>
              Promise.resolve(
                script.insert?.error
                  ? { data: null, error: script.insert.error }
                  : { data: script.insert?.data ?? null, error: null },
              ),
          }),
        };
      },
    }),
  } as unknown as SupabaseClient<Database>;
  return { db, inserts, selectCount: () => selectCalls };
};

const june = { id: 'b-1', period_start: '2026-06-03', period_end: '2026-06-03' };

describe('findOrCreateOffCycleBatch — one open batch per employer', () => {
  it('returns the existing open batch without inserting', async () => {
    const { db, inserts } = stubDb({ selects: [june] });
    const batch = await findOrCreateOffCycleBatch(db, 'co-1', '2026-08-27');
    expect(batch).toEqual({
      id: 'b-1',
      periodStart: '2026-06-03',
      periodEnd: '2026-06-03',
      isNew: false,
    });
    expect(inserts).toHaveLength(0);
  });

  it('creates a batch dated today when none is open', async () => {
    const created = { id: 'b-2', period_start: '2026-08-27', period_end: '2026-08-27' };
    const { db, inserts } = stubDb({ selects: [null], insert: { data: created } });
    const batch = await findOrCreateOffCycleBatch(db, 'co-1', '2026-08-27');
    expect(batch.isNew).toBe(true);
    expect(batch.id).toBe('b-2');
    expect(inserts[0]).toMatchObject({
      company_id: 'co-1',
      period_start: '2026-08-27',
      period_end: '2026-08-27',
      pay_date: '2026-08-27',
      state: 'open',
      kind: 'off_cycle',
    });
  });

  it('adopts the winner when the unique index rejects a concurrent create (23505)', async () => {
    const winner = { id: 'b-race', period_start: '2026-08-27', period_end: '2026-08-27' };
    const { db, selectCount } = stubDb({
      selects: [null, winner],
      insert: {
        error: { message: 'duplicate key … pay_periods_off_cycle_open_uniq', code: '23505' },
      },
    });
    const batch = await findOrCreateOffCycleBatch(db, 'co-1', '2026-08-27');
    expect(batch).toEqual({
      id: 'b-race',
      periodStart: '2026-08-27',
      periodEnd: '2026-08-27',
      isNew: false,
    });
    expect(selectCount()).toBe(2);
  });

  it('still throws on non-race insert errors', async () => {
    const { db } = stubDb({
      selects: [null],
      insert: { error: { message: 'permission denied', code: '42501' } },
    });
    await expect(findOrCreateOffCycleBatch(db, 'co-1', '2026-08-27')).rejects.toThrow(
      'off-cycle batch create: permission denied',
    );
  });
});
