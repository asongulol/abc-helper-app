import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { endEngagement } from '@/db/queries/workers';
import type { Database } from '@/db/types';

/** Records every update payload + filter, so a dropped end-date fails the test.
 *  A real Promise underneath, like the awaitable Supabase builder. */
type Chain = Promise<{ data: unknown[]; error: null; count: number }> & Record<string, unknown>;

type Call = {
  table: string;
  op: 'update' | 'select';
  patch: Record<string, unknown> | null;
  filters: Record<string, unknown>;
};

const stubDb = (opts: { endedCompanyIds?: string[]; remainingActive?: number } = {}) => {
  const calls: Call[] = [];
  const make = (rec: Call): Chain => {
    const chain = Promise.resolve({
      data: (opts.endedCompanyIds ?? []).map((id) => ({ company_id: id })),
      error: null,
      count: opts.remainingActive ?? 0,
    }) as unknown as Chain;
    const record = (col: string, val: unknown) => {
      rec.filters[col] = val;
      return chain;
    };
    chain.eq = record;
    chain.is = (col: string, val: unknown) => record(`${col} is`, val);
    chain.lte = (col: string, val: unknown) => record(`${col}<=`, val);
    chain.select = () => chain;
    return chain;
  };
  const db = {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => {
        const rec: Call = { table, op: 'update', patch, filters: {} };
        calls.push(rec);
        return make(rec);
      },
      select: () => {
        const rec: Call = { table, op: 'select', patch: null, filters: {} };
        calls.push(rec);
        return make(rec);
      },
    }),
  };
  return { db: db as unknown as SupabaseClient<Database>, calls };
};

const find = (calls: Call[], table: string, op: Call['op'] = 'update') =>
  calls.find((c) => c.table === table && c.op === op);

describe('endEngagement — a departure closes everything it left open', () => {
  it('ends the link, the rate and the coverage target on the same last day', async () => {
    const { db, calls } = stubDb({ endedCompanyIds: ['co-1'] });
    await endEngagement(db, { workerId: 'w1', companyId: 'co-1', lastDay: '2026-07-31' });

    expect(find(calls, 'worker_companies')?.patch).toEqual({
      status: 'ended',
      ended_on: '2026-07-31',
    });
    // The root cause behind #75: an open rate outlived the person, so a recalc
    // could still resolve pay for them.
    expect(find(calls, 'rates')?.patch).toEqual({ effective_end: '2026-07-31' });
    expect(find(calls, 'coverage_targets')?.patch).toEqual({ effective_to: '2026-07-31' });
  });

  it('scopes every write to the one company when a companyId is given', async () => {
    const { db, calls } = stubDb({ endedCompanyIds: ['co-1'] });
    await endEngagement(db, { workerId: 'w1', companyId: 'co-1', lastDay: '2026-07-31' });

    for (const table of ['worker_companies', 'rates', 'coverage_targets']) {
      expect(find(calls, table)?.filters).toMatchObject({ worker_id: 'w1', company_id: 'co-1' });
    }
  });

  it('drops the company filter for a full termination, so every link ends', async () => {
    const { db, calls } = stubDb({ endedCompanyIds: ['co-1', 'co-2'] });
    const res = await endEngagement(db, { workerId: 'w1', companyId: null, lastDay: '2026-07-31' });

    for (const table of ['worker_companies', 'rates', 'coverage_targets']) {
      expect(find(calls, table)?.filters).not.toHaveProperty('company_id');
    }
    expect(res.endedCompanyIds).toEqual(['co-1', 'co-2']);
  });

  it('never closes a row that starts after the last day (CHECK end >= start)', async () => {
    const { db, calls } = stubDb();
    await endEngagement(db, { workerId: 'w1', companyId: null, lastDay: '2026-07-31' });

    expect(find(calls, 'rates')?.filters).toMatchObject({
      'effective_end is': null,
      'effective_start<=': '2026-07-31',
    });
    expect(find(calls, 'coverage_targets')?.filters).toMatchObject({
      'effective_to is': null,
      'effective_from<=': '2026-07-31',
    });
  });

  it('reports the links still active, so the caller can drop them to inactive', async () => {
    const { db, calls } = stubDb({ endedCompanyIds: ['co-1'], remainingActive: 2 });
    const res = await endEngagement(db, {
      workerId: 'w1',
      companyId: 'co-1',
      lastDay: '2026-07-31',
    });

    expect(res.remainingActive).toBe(2);
    expect(find(calls, 'worker_companies', 'select')?.filters).toMatchObject({
      worker_id: 'w1',
      status: 'active',
    });
  });
});
