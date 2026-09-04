/**
 * saveRate under a versioned contract (docs/CONTRACT-VERSIONS-PLAN.md decision
 * 8): once countersign has written the rate, a direct save is a correction
 * only — owner-only, and it must match the contract of record. Engagements
 * without a versioned contract keep the free editor.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type Row, type Tables } from '../../fixtures/supabase-fake';

const W = '33333333-3333-4333-8333-333333333333';
const CO = '11111111-1111-4111-8111-111111111111';

const world = vi.hoisted(() => ({ db: null as unknown, isOwner: true }));

vi.mock('@/db/clients/server', () => ({ createServerSupabase: async () => world.db }));
vi.mock('@/db/clients/service', () => ({ createServiceClient: () => world.db }));
vi.mock('@/server/auth/admin', () => ({
  getCurrentAdmin: async () => ({
    userId: 'admin-1',
    email: 'a@abckidsny.com',
    companyIds: [CO],
    isOwner: world.isOwner,
  }),
}));
vi.mock('@/server/audit', () => ({ logEvent: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { saveRate } = await import('@/server/actions/payroll');

const boot = (o: { contract?: Row | null } = {}): Tables => {
  const fake = fakeSupabase({
    rates: [
      {
        id: 'r-1',
        worker_id: W,
        company_id: CO,
        amount_php: 25000,
        effective_start: '2026-09-16',
        effective_end: null,
      },
    ],
    contract_versions:
      o.contract === null
        ? []
        : [
            {
              id: 'v-2',
              worker_id: W,
              company_id: CO,
              version: 2,
              status: 'active',
              rate_php: 25000,
              effective_from: '2026-09-16',
              ...o.contract,
            },
          ],
  });
  world.db = fake.client;
  return fake.tables;
};

beforeEach(() => {
  world.isOwner = true;
});

describe('saveRate with a versioned contract of record', () => {
  it('lets the owner correct the effective date at the contract amount', async () => {
    const tables = boot();

    const res = await saveRate({
      workerId: W,
      companyId: CO,
      amountPhp: 25000,
      effectiveStart: '2026-09-01',
    });

    expect(res).toMatchObject({ ok: true, data: { kind: 'close-and-insert' } });
    expect(tables.rates).toHaveLength(2);
  });

  it('rejects an amount away from the contract — that is a new contract', async () => {
    const tables = boot();

    const res = await saveRate({
      workerId: W,
      companyId: CO,
      amountPhp: 26000,
      effectiveStart: '2026-10-01',
    });

    expect(res).toMatchObject({ ok: false, error: /version 2.*25,000\.00.*new contract/ });
    expect(tables.rates).toHaveLength(1);
  });

  it('is owner-only', async () => {
    world.isOwner = false;
    const tables = boot();

    const res = await saveRate({
      workerId: W,
      companyId: CO,
      amountPhp: 25000,
      effectiveStart: '2026-09-01',
    });

    expect(res).toMatchObject({ ok: false, error: /issuing a new contract/ });
    expect(tables.rates).toHaveLength(1);
  });

  it('leaves a legacy engagement (no versioned contract) on the free editor', async () => {
    world.isOwner = false;
    const tables = boot({ contract: null });

    const res = await saveRate({
      workerId: W,
      companyId: CO,
      amountPhp: 26000,
      effectiveStart: '2026-10-01',
    });

    expect(res).toMatchObject({ ok: true });
    expect(tables.rates).toHaveLength(2);
  });
});
