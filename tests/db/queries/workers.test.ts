import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { endEngagement, hasPayOutstanding } from '@/db/queries/workers';
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

/** Reads only, so the stub just answers per table. */
type ReadChain = Promise<{ data: unknown[] | null; error: null; count: number | null }> &
  Record<string, unknown>;

const payStub = (fixture: {
  links?: { ended_on: string | null }[];
  payments?: { paid_at: string | null; pay_periods: { period_end: string } | null }[];
  unpaidSessions?: number;
}) => {
  const answer = (table: string) => {
    if (table === 'worker_companies')
      return { data: fixture.links ?? [], error: null, count: null };
    if (table === 'payments') return { data: fixture.payments ?? [], error: null, count: null };
    return { data: null, error: null, count: fixture.unpaidSessions ?? 0 };
  };
  const db = {
    from: (table: string) => {
      const chain = Promise.resolve(answer(table)) as unknown as ReadChain;
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.is = () => chain;
      return chain;
    },
  };
  return db as unknown as SupabaseClient<Database>;
};

const LAST_DAY = '2026-07-15';
const finalPay = { paid_at: '2026-07-31T00:00:00Z', pay_periods: { period_end: '2026-07-31' } };

describe('hasPayOutstanding — access outlives the last day, not the last payment', () => {
  it('keeps access while a payment has not landed', async () => {
    expect(
      await hasPayOutstanding(
        payStub({
          links: [{ ended_on: LAST_DAY }],
          payments: [finalPay, { paid_at: null, pay_periods: { period_end: '2026-08-15' } }],
        }),
        'w1',
      ),
    ).toBe(true);
  });

  // The reason this is not a payments-only check. Ended on the 15th, payroll for
  // that period has not run, so NO row exists yet to be found unpaid.
  it('keeps access when the final period has not been run at all', async () => {
    expect(
      await hasPayOutstanding(payStub({ links: [{ ended_on: LAST_DAY }], payments: [] }), 'w1'),
    ).toBe(true);
  });

  it('keeps access when every landed payment predates the last day', async () => {
    expect(
      await hasPayOutstanding(
        payStub({
          links: [{ ended_on: LAST_DAY }],
          payments: [
            { paid_at: '2026-06-30T00:00:00Z', pay_periods: { period_end: '2026-06-30' } },
          ],
        }),
        'w1',
      ),
    ).toBe(true);
  });

  // The #79 drift: 'ended' workers whose link was never stamped. No last day to
  // prove final pay against, so never lock them out on a guess.
  it('keeps access when no link carries an end date', async () => {
    expect(
      await hasPayOutstanding(payStub({ links: [{ ended_on: null }], payments: [] }), 'w1'),
    ).toBe(true);
  });

  it('keeps access for approved sessions no period covers', async () => {
    expect(
      await hasPayOutstanding(
        payStub({ links: [{ ended_on: LAST_DAY }], payments: [finalPay], unpaidSessions: 2 }),
        'w1',
      ),
    ).toBe(true);
  });

  it('uses the LATEST end date, so the earlier-ended link cannot call it settled', async () => {
    expect(
      await hasPayOutstanding(
        payStub({
          links: [{ ended_on: '2026-05-31' }, { ended_on: '2026-08-31' }],
          payments: [finalPay],
        }),
        'w1',
      ),
    ).toBe(true);
  });

  it('ends access once the pay covering the last day has landed and nothing is left', async () => {
    expect(
      await hasPayOutstanding(
        payStub({ links: [{ ended_on: LAST_DAY }], payments: [finalPay], unpaidSessions: 0 }),
        'w1',
      ),
    ).toBe(false);
  });
});
