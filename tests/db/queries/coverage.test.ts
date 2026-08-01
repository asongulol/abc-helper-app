import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { fetchCoverageExpectations } from '@/db/queries/coverage';
import type { Database } from '@/db/types';

/** Records the filters each query applies, so a dropped filter fails the test.
 *  A real Promise underneath, like the awaitable Supabase builder. */
type Chain = Promise<{ data: unknown[]; error: null }> & Record<string, unknown>;

const stubDb = (rowsByTable: Record<string, unknown[]>) => {
  const calls: Array<{ table: string; filters: Record<string, unknown>; or: string[] }> = [];
  const db = {
    from: (table: string) => ({
      select: () => {
        const rec = { table, filters: {} as Record<string, unknown>, or: [] as string[] };
        calls.push(rec);
        const chain = Promise.resolve({
          data: rowsByTable[table] ?? [],
          error: null,
        }) as unknown as Chain;
        const record = (col: string, val: unknown) => {
          rec.filters[col] = val;
          return chain;
        };
        chain.eq = record;
        chain.in = record;
        chain.lte = (col: string, val: unknown) => record(`${col}<=`, val);
        chain.or = (expr: string) => {
          rec.or.push(expr);
          return chain;
        };
        return chain;
      },
    }),
  };
  return { db: db as unknown as SupabaseClient<Database>, calls };
};

describe('fetchCoverageExpectations — the gap list is active, time-tracked contractors only', () => {
  const run = async () => {
    const { db, calls } = stubDb({
      worker_companies: [
        { worker_id: 'w1', weekly_hours: 40, workers: { first_name: 'Ana', last_name: 'Cruz' } },
      ],
      coverage_targets: [],
    });
    const out = await fetchCoverageExpectations(db, 'co-1', '2026-07-01', '2026-07-15');
    return { calls, out };
  };

  it('asks only for active links on active workers', async () => {
    const { calls } = await run();
    expect(calls[0]?.filters).toMatchObject({
      company_id: 'co-1',
      // The link's own status — an ended engagement isn't coverage...
      status: 'active',
      // ...and neither is a stale-active link on a worker who has left (6 such rows in prod).
      'workers.status': 'active',
    });
  });

  it('excludes links with no Hubstaff identity — admins who never log time', async () => {
    const { calls } = await run();
    expect(calls[0]?.or).toContain('hubstaff_user_id.not.is.null,hubstaff_name.not.is.null');
  });

  it('still scales weekly_hours over the period for whoever survives the filters', async () => {
    const { out } = await run();
    // 15-day period ≈ 2.142857 weeks × 40h
    expect(out).toHaveLength(1);
    expect(out[0]?.workerName).toBe('Ana Cruz');
    expect(out[0]?.expectedHours).toBeCloseTo((40 * 15) / 7, 6);
  });
});
