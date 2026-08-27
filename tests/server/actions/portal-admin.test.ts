/**
 * `withdrawOffer` must END the engagement, not just label it.
 *
 * It used to PATCH a bare `status='ended'` across every worker_companies row,
 * leaving `ended_on` NULL. `ended_on` is what every last-day rule measures
 * against — the time-import guard, the allowance gate, the portal's final-pay
 * gate — so an unstamped 'ended' link is a departure with no last day and none
 * of them bind (#86). Migration 37 makes that write a CHECK violation outright.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const WORKER = '33333333-3333-4333-8333-333333333333';

/** Supabase builder stub: every step returns itself; awaiting yields `result`. */
const clients = vi.hoisted(() => {
  const patches: unknown[] = [];
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {
      // biome-ignore lint/suspicious/noThenProperty: a supabase query builder is awaitable at every step — that is the thing being stubbed
      then: (resolve: (v: unknown) => void) => resolve(result),
      update: (p: unknown) => {
        patches.push(p);
        return c;
      },
    };
    for (const k of ['select', 'eq', 'maybeSingle']) c[k] = () => c;
    return c;
  };
  return {
    chain,
    patches,
    // Payroll-history probes read `count`; withdrawOffer refuses if either is > 0.
    rls: { from: vi.fn(() => chain({ count: 0, data: null, error: null })) },
    service: {
      from: vi.fn(() => chain({ data: null, error: null })),
      auth: { admin: { updateUserById: vi.fn().mockResolvedValue({}) } },
    },
  };
});
const q = vi.hoisted(() => ({ endEngagement: vi.fn() }));

vi.mock('@/db/queries/workers', () => q);
vi.mock('@/db/clients/server', () => ({ createServerSupabase: async () => clients.rls }));
vi.mock('@/db/clients/service', () => ({ createServiceClient: () => clients.service }));
vi.mock('@/server/auth/admin', () => ({
  getCurrentAdmin: async () => ({ email: 'owner@abckidsny.com', companyIds: [], isOwner: true }),
}));
vi.mock('@/server/audit', () => ({ logEvent: vi.fn() }));
vi.mock('@/server/email/transport', () => ({ sendEmail: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('@/server/env', () => ({ env: { APP_URL: 'http://localhost:3000' } }));
// Imported by the action module but unused on this path.
vi.mock('@/db/queries/onboarding', () => ({
  seedOnboardingProgress: vi.fn(),
  seedAgreementPrefill: vi.fn(),
}));
vi.mock('@/db/queries/secrets', () => ({ decryptWorkerTools: vi.fn() }));

const { restorePortalLogin, revokePortalLogin, withdrawOffer } = await import(
  '@/server/actions/portal-admin'
);

beforeEach(() => {
  vi.clearAllMocks();
  clients.patches.length = 0;
  q.endEngagement.mockResolvedValue({ endedCompanyIds: [] });
});

describe('withdrawOffer', () => {
  it('ends every link through endEngagement, stamped with a last day', async () => {
    const res = await withdrawOffer({ workerId: WORKER });

    expect(res.ok).toBe(true);
    expect(q.endEngagement).toHaveBeenCalledTimes(1);
    const [db, args] = q.endEngagement.mock.calls[0] as [unknown, Record<string, unknown>];
    // Service client: a company-scoped admin cannot see every link through RLS
    // and would silently withdraw only part of the offer.
    expect(db).toBe(clients.service);
    expect(args.workerId).toBe(WORKER);
    // null = every company, not just one.
    expect(args.companyId).toBeNull();
    // A real date, so `ended_on` is never NULL — the whole point.
    expect(args.lastDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/**
 * `contractor_logins` has exactly one RLS policy and it is SELECT-only, so both
 * of these writes match 0 rows — and report success — through a user-session
 * client. Revoke did that silently until #85: the button said "Portal access
 * revoked" and RLS kept letting the contractor read everything.
 */
describe('portal login status writes go through the service client', () => {
  it('revoke sets status revoked on the service client, never the RLS one', async () => {
    const res = await revokePortalLogin({ workerId: WORKER });

    expect(res.ok).toBe(true);
    expect(clients.service.from).toHaveBeenCalledWith('contractor_logins');
    expect(clients.rls.from).not.toHaveBeenCalled();
    expect(clients.patches).toEqual([{ status: 'revoked' }]);
  });

  // The undo for the nightly sunset sweep: pay re-drafted after a bounced
  // transfer means they are owed again, and nothing else can let them back in.
  it('restore puts a revoked login back to active', async () => {
    clients.service.from.mockReturnValueOnce(
      clients.chain({ data: { status: 'revoked' }, error: null }),
    );

    const res = await restorePortalLogin({ workerId: WORKER });

    expect(res.ok).toBe(true);
    expect(clients.patches).toEqual([{ status: 'active' }]);
  });

  it('restore refuses when there is no login to restore', async () => {
    const res = await restorePortalLogin({ workerId: WORKER });

    expect(res.ok).toBe(false);
    expect(clients.patches).toEqual([]);
  });
});
