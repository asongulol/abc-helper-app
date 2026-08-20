/**
 * onboardCurrentContractor — invites an EXISTING worker and prepares the
 * agreement prefill. The invariants: createPortalLogin is the gate (its
 * failure means no prefill writes), engagement terms + addendum land on the
 * IC Agreement only while countersigner/company/basis land on all four, and
 * the tools RPC fires only when a tool was actually requested.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const WORKER = '33333333-3333-4333-8333-333333333333';
const COMPANY = '11111111-1111-4111-8111-111111111111';
const CSIGNER = '44444444-4444-4444-8444-444444444444';

const world = vi.hoisted(() => ({
  upserts: [] as Record<string, unknown>[],
  rpcs: [] as { fn: string; args: unknown }[],
  login: { ok: true, data: { tempPassword: 'pw', emailSent: true } } as unknown,
}));

vi.mock('@/server/auth/admin', () => ({
  getCurrentAdmin: async () => ({ userId: 'admin-1', email: 'a@x.com' }),
}));
vi.mock('@/server/audit', () => ({ logEvent: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/actions/payroll', () => ({ saveRate: vi.fn() }));
vi.mock('@/server/actions/portal-admin', () => ({
  createPortalLogin: vi.fn(async () => world.login),
}));
vi.mock('@/db/queries/invoicing', () => ({ fetchActiveClients: vi.fn() }));
vi.mock('@/db/queries/workers', () => ({}));
// Real queries/onboarding pulls crypto, which validates server env at import time.
vi.mock('@/db/queries/onboarding', () => ({
  AGREEMENT_KINDS: ['ic_agreement', 'non_compete', 'confidentiality_nda', 'baa'],
  deriveAgreementPrefill: vi.fn(),
}));
vi.mock('@/db/clients/server', () => ({ createServerSupabase: vi.fn() }));
vi.mock('@/db/clients/service', () => ({
  createServiceClient: () => ({
    from: () => {
      const c: Record<string, unknown> = {
        // biome-ignore lint/suspicious/noThenProperty: a supabase query builder is awaitable at every step — that is the thing being stubbed
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
        maybeSingle: async () => ({ data: { name: 'Acme LLC' }, error: null }),
        upsert: (row: Record<string, unknown>) => {
          world.upserts.push(row);
          return c;
        },
      };
      for (const k of ['select', 'eq']) c[k] = () => c;
      return c;
    },
    rpc: async (fn: string, args: unknown) => {
      world.rpcs.push({ fn, args });
      return { data: null, error: null };
    },
  }),
}));

const { onboardCurrentContractor } = await import('@/server/actions/contractors');

const input = (over: Record<string, unknown> = {}) => ({
  workerId: WORKER,
  companyId: COMPANY,
  email: 'hazzan@example.com',
  position: 'QA Specialist',
  ratePhp: 15000,
  startDate: '2026-05-13',
  employmentType: 'part_time',
  hoursPerWeek: 20,
  countersignerUserId: CSIGNER,
  countersignerName: 'Jane Owner',
  icAddendumType: '',
  icAddendumText: null,
  tools: { gmail: false, providersoft: false, hubstaff: false, zoom: false, others: '' },
  ...over,
});

beforeEach(() => {
  world.upserts = [];
  world.rpcs = [];
  world.login = { ok: true, data: { tempPassword: 'pw', emailSent: true } };
});

describe('onboardCurrentContractor', () => {
  it('prepares all 4 agreements; terms on IC only, countersigner on all', async () => {
    const res = await onboardCurrentContractor(input());
    expect(res).toMatchObject({ ok: true, data: { tempPassword: 'pw' } });
    expect(world.upserts.map((u) => u.agreement_kind)).toEqual([
      'ic_agreement',
      'non_compete',
      'confidentiality_nda',
      'baa',
    ]);
    expect(world.upserts[0]).toMatchObject({
      f_rate: '15000',
      f_position: 'QA Specialist',
      f_start_date: '2026-05-13',
      f_company_name: 'Acme LLC',
      countersigner_user_id: CSIGNER,
      prepared_by: 'admin-1',
    });
    for (const u of world.upserts.slice(1)) {
      expect(u.f_rate).toBeUndefined();
      expect(u).toMatchObject({ f_company_name: 'Acme LLC', countersigner_user_id: CSIGNER });
    }
    expect(world.rpcs).toHaveLength(0); // no tools requested
  });

  it('requests tools via the RPC when any tool is picked', async () => {
    await onboardCurrentContractor(
      input({
        tools: { gmail: true, providersoft: false, hubstaff: false, zoom: false, others: '' },
      }),
    );
    expect(world.rpcs).toEqual([
      { fn: 'set_tools_requested', args: { p_worker_id: WORKER, p_requested: expect.anything() } },
    ]);
  });

  it('stops at the login gate — a failed login writes no prefill', async () => {
    world.login = { ok: false, error: 'This contractor already has a portal login (x, active).' };
    const res = await onboardCurrentContractor(input());
    expect(res.ok).toBe(false);
    expect(world.upserts).toHaveLength(0);
  });
});
