import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { fetchActualHours, fetchCoverageExpectations } from '@/db/queries/coverage';
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
        // Range bounds get their own keys — both are work_date, so one map slot
        // would hide a dropped end of the window.
        chain.gte = (col: string, val: unknown) => record(`${col}>=`, val);
        chain.lte = (col: string, val: unknown) => record(`${col}<=`, val);
        chain.limit = () => chain;
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

  // #94: resolveTargetHours does no date filtering of its own, so these bounds
  // are the only thing between a target that expired last year and the bar this
  // period is measured against.
  it('bounds explicit targets to this company and to the period they are effective in', async () => {
    const { calls } = await run();

    expect(calls[1]?.filters).toEqual({
      worker_id: ['w1'],
      'effective_from<=': '2026-07-15',
    });
    expect(calls[1]?.or).toEqual([
      'company_id.eq.co-1,company_id.is.null',
      'effective_to.is.null,effective_to.gte.2026-07-01',
    ]);
  });
});

describe('fetchActualHours — hours only count inside the period, at this company', () => {
  // #94: nothing downstream re-checks the dates. Drop either bound and every
  // worker's all-time hours land in this period's total, every gap closes, and
  // the page reports "all on track" with no way to tell.
  it('bounds the read by company, worker and both ends of the window', async () => {
    const { db, calls } = stubDb({ time_entries: [] });
    await fetchActualHours(db, 'co-1', ['w1'], '2026-07-01', '2026-07-15');

    expect(calls[0]?.filters).toEqual({
      company_id: 'co-1',
      worker_id: ['w1'],
      'work_date>=': '2026-07-01',
      'work_date<=': '2026-07-15',
    });
  });
});
