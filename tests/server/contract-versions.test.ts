/**
 * Contract versions, slice 1 (docs/CONTRACT-VERSIONS-PLAN.md §6.1): the reads
 * see the new table, and the one existing write path that must know about it
 * — ending an engagement — stamps the contract of record.
 *
 * The one-in-flight / one-active invariants are partial unique indexes, so
 * they are proven against the real schema (supabase migration up + a rolled-back
 * probe: second draft, second active, v1, effective_from < start all rejected),
 * not here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { contractOfRecord } from '@/db/queries/contracts';
import { endEngagement } from '@/db/queries/workers';
import type { Database } from '@/db/types';

type Call = { table: string; patch?: Record<string, unknown>; filters: Record<string, unknown> };

/** Records every builder call; a read resolves to the fixture row for its table. */
const stub = (rows: Record<string, unknown> = {}) => {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, filters: {} };
    calls.push(call);
    const answer = () => ({ data: rows[table] ?? null, error: null });
    const c: Record<string, unknown> = {
      // biome-ignore lint/suspicious/noThenProperty: a supabase query builder is awaitable at every step — that is the thing being stubbed
      then: (resolve: (v: unknown) => void) => Promise.resolve(answer()).then(resolve),
    };
    const record = (col: string, val: unknown) => {
      call.filters[col] = val;
      return c;
    };
    for (const m of ['select', 'order', 'limit']) c[m] = () => c;
    c.update = (p: Record<string, unknown>) => {
      call.patch = p;
      return c;
    };
    c.eq = record;
    c.neq = (col: string, val: unknown) => record(`${col} !=`, val);
    c.lte = (col: string, val: unknown) => record(`${col} <=`, val);
    c.is = (col: string, val: unknown) => record(`${col} is`, val);
    c.maybeSingle = () => Promise.resolve(answer());
    return c;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
};

const W = 'w-1';
const CO = 'co-a';
const LAST_DAY = '2026-09-15';

describe('endEngagement stamps the contract of record', () => {
  it('ends the ACTIVE version of that engagement as of the last day', async () => {
    const { db, calls } = stub();
    await endEngagement(db, { workerId: W, companyId: CO, lastDay: LAST_DAY });

    const stamp = calls.find((c) => c.table === 'contract_versions');
    expect(stamp?.patch).toEqual({ status: 'ended', ended_on: LAST_DAY });
    // Only 'active': an in-flight draft/sent/signed is the admin's to void.
    expect(stamp?.filters).toEqual({ worker_id: W, status: 'active', company_id: CO });
  });

  it('covers every company on a full termination', async () => {
    const { db, calls } = stub();
    await endEngagement(db, { workerId: W, companyId: null, lastDay: LAST_DAY });

    const stamp = calls.find((c) => c.table === 'contract_versions');
    expect(stamp?.filters).toEqual({ worker_id: W, status: 'active' });
  });
});

describe('contractOfRecord', () => {
  const link = { contract: 'FT', role: 'VA', weekly_hours: 40, started_on: '2024-01-15' };

  it('returns the active version when one exists', async () => {
    const { db } = stub({
      contract_versions: { id: 'v2', version: 2, status: 'active', rate_php: '25000.00' },
      worker_companies: link,
    });
    const c = await contractOfRecord(db, W, CO);
    expect(c).toMatchObject({ source: 'versioned', id: 'v2', version: 2, ratePhp: 25000 });
  });

  it('reads version 1 through the legacy rows, rate from the rates table', async () => {
    const { db } = stub({
      worker_companies: link,
      onboarding_agreements: {
        f_rate: '20000', // stale prep text — the rates row is the money truth
        f_position: 'Virtual Assistant',
        f_start_date: '2024-01-15',
        countersigned_at: '2024-01-12T00:00:00Z',
        countersigned_name: 'Owner',
      },
      rates: { amount_php: '22000', period_basis: 'semi_monthly', effective_start: '2026-01-01' },
      onboarding_signatures: { signed_at: '2024-01-10T00:00:00Z', doc_sha256: 'abc' },
    });
    const c = await contractOfRecord(db, W, CO);
    expect(c).toMatchObject({
      source: 'legacy',
      version: 1,
      id: null,
      ratePhp: 22000,
      effectiveFrom: '2026-01-01',
      position: 'Virtual Assistant',
      employmentType: 'FT',
      hoursPerWeek: 40,
      startDate: '2024-01-15',
      signedAt: '2024-01-10T00:00:00Z',
      countersignedName: 'Owner',
      docSha256: 'abc',
    });
  });

  it('is null when the worker has no link to the company', async () => {
    const { db } = stub({ rates: { amount_php: '22000' } });
    expect(await contractOfRecord(db, W, CO)).toBeNull();
  });
});
