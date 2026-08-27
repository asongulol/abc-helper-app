/**
 * The nightly portal-access sunset (#85).
 *
 * `contractor_logins.status` is the whole contractor RLS story — `my_worker_id()`
 * resolves any login row with status = 'active' — so this sweep is what makes
 * "access ends when the money lands" true for the legacy portal and raw
 * PostgREST, not just for this app's resolver.
 *
 * Direction is the thing under test. Revoking someone still owed money strands
 * them from the only screen showing their own pay records, with no self-service
 * undo; a late revocation costs nothing. So: ended-and-fully-paid revokes,
 * everything else — outstanding pay, still working, an already-revoked login, a
 * failed read — does not.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { sunsetPortalLogins } from '@/db/queries/workers';
import type { Database } from '@/db/types';

type Pay = {
  links: { company_id: string; ended_on: string | null }[];
  payments: {
    paid_at: string | null;
    company_id: string;
    pay_periods: { period_start: string; period_end: string } | null;
  }[];
  unpaidSessions?: number;
};

type World = {
  /** worker ids with workers.status = 'ended'. */
  ended: string[];
  /** worker ids whose contractor_logins row is still 'active'. */
  activeLogins: string[];
  pay: Record<string, Pay>;
  /** Table whose read fails, to prove the sweep stops instead of guessing. */
  failReadOn?: string;
};

type Update = { table: string; patch: Record<string, unknown>; filters: Record<string, unknown> };

/** Supabase builder stub: filters are recorded, the answer is computed at await
 *  time (the sweep asks per worker, so the reply depends on `worker_id`). */
const stub = (world: World) => {
  const updates: Update[] = [];
  const reads: Record<string, string> = {};

  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;

    const answer = () => {
      if (patch) return { data: null, error: null, count: null };
      if (world.failReadOn === table)
        return { data: null, error: { message: 'boom' }, count: null };
      if (table === 'workers')
        return { data: world.ended.map((id) => ({ id })), error: null, count: null };
      if (table === 'contractor_logins') {
        const wanted = (filters.worker_id as string[] | undefined) ?? [];
        return {
          data: world.activeLogins
            .filter((id) => wanted.includes(id))
            .map((worker_id) => ({ worker_id })),
          error: null,
          count: null,
        };
      }
      const fixture = world.pay[filters.worker_id as string];
      if (table === 'worker_companies')
        return { data: fixture?.links ?? [], error: null, count: null };
      if (table === 'payments') return { data: fixture?.payments ?? [], error: null, count: null };
      return { data: null, error: null, count: fixture?.unpaidSessions ?? 0 };
    };

    const c: Record<string, unknown> = {
      // biome-ignore lint/suspicious/noThenProperty: a supabase query builder is awaitable at every step — that is the thing being stubbed
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        Promise.resolve(answer()).then(resolve, reject),
    };
    const record = (col: string, val: unknown) => {
      filters[col] = val;
      return c;
    };
    c.select = (cols?: string) => {
      reads[table] = cols ?? '';
      return c;
    };
    c.update = (p: Record<string, unknown>) => {
      patch = p;
      updates.push({ table, patch: p, filters });
      return c;
    };
    c.eq = record;
    c.in = record;
    c.is = (col: string, val: unknown) => record(`${col} is`, val);
    c.maybeSingle = () => Promise.resolve(answer());
    return c;
  };

  return { db: { from } as unknown as SupabaseClient<Database>, updates, reads };
};

const WORKER = 'w-gone';
const CO = 'co-a';
const LAST_DAY = '2026-07-15';
/** The semi-monthly period that CONTAINS the last day — the one owing the final stub. */
const finalPay = {
  paid_at: '2026-07-31T00:00:00Z',
  company_id: CO,
  pay_periods: { period_start: '2026-07-01', period_end: '2026-07-15' },
};
const settled: Pay = { links: [{ company_id: CO, ended_on: LAST_DAY }], payments: [finalPay] };
/** Ended on the 15th, that period's payroll has not run — the row that will owe
 *  them does not exist yet. This is the gap right after a termination. */
const owed: Pay = { links: [{ company_id: CO, ended_on: LAST_DAY }], payments: [] };

const revocations = (updates: Update[]) =>
  updates.filter((u) => u.table === 'contractor_logins' && u.patch.status === 'revoked');

describe('sunsetPortalLogins — RLS enforces the end of access, not just the resolver', () => {
  it('revokes the login of a contractor who is ended and fully paid', async () => {
    const { db, updates } = stub({
      ended: [WORKER],
      activeLogins: [WORKER],
      pay: { [WORKER]: settled },
    });

    const res = await sunsetPortalLogins(db);

    expect(res.revoked).toEqual([WORKER]);
    const [revoke] = revocations(updates);
    // Same column and same value as revokePortalLogin: `my_worker_id()` only
    // ever asks `status = 'active'`, so manual and automatic revocation have to
    // be indistinguishable to RLS.
    expect(revoke?.patch).toEqual({ status: 'revoked' });
    expect(revoke?.filters).toMatchObject({ worker_id: WORKER, status: 'active' });
  });

  it('leaves a departed contractor alone while pay is still outstanding', async () => {
    const { db, updates } = stub({
      ended: [WORKER],
      activeLogins: [WORKER],
      pay: { [WORKER]: owed },
    });

    const res = await sunsetPortalLogins(db);

    expect(res.revoked).toEqual([]);
    expect(revocations(updates)).toHaveLength(0);
  });

  it('never touches a contractor who has not ended', async () => {
    // No worker carries status 'ended', so the candidate list is empty — a
    // still-working contractor can never be reached by this sweep, whatever
    // their payment history says.
    const { db, updates, reads } = stub({
      ended: [],
      activeLogins: [WORKER],
      pay: { [WORKER]: settled },
    });

    const res = await sunsetPortalLogins(db);

    expect(res).toEqual({ checked: 0, revoked: [] });
    expect(updates).toHaveLength(0);
    expect(reads.workers).toBe('id');
  });

  it('skips a login that is not active, so a manual revoke is never re-written', async () => {
    const { db, updates } = stub({ ended: [WORKER], activeLogins: [], pay: { [WORKER]: settled } });

    const res = await sunsetPortalLogins(db);

    expect(res).toEqual({ checked: 0, revoked: [] });
    expect(updates).toHaveLength(0);
  });

  it('revokes only the settled contractor when several have departed', async () => {
    const still = 'w-owed';
    const { db, updates } = stub({
      ended: [WORKER, still],
      activeLogins: [WORKER, still],
      pay: { [WORKER]: settled, [still]: owed },
    });

    const res = await sunsetPortalLogins(db);

    expect(res).toEqual({ checked: 2, revoked: [WORKER] });
    expect(revocations(updates).map((u) => u.filters.worker_id)).toEqual([WORKER]);
  });

  it('stops without revoking anyone when a read fails', async () => {
    // `hasPayOutstanding` throws rather than answering "paid" on a broken read.
    // Fail closed: tomorrow's tick retries, and nobody is locked out on a guess.
    const { db, updates } = stub({
      ended: [WORKER],
      activeLogins: [WORKER],
      pay: { [WORKER]: settled },
      failReadOn: 'payments',
    });

    await expect(sunsetPortalLogins(db)).rejects.toThrow(/payments outstanding/);
    expect(updates).toHaveLength(0);
  });
});
