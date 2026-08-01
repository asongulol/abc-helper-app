/**
 * The termination stack's global-status decisions.
 *
 * `workers.status` is global, but `worker_companies` is RLS-scoped per admin.
 * Every test here exists because a global decision was being made from a scoped
 * read (#82, #83) or from no read at all (#88), and because the one legally
 * sensitive audit row in the stack was being dropped by RLS (#93).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerLink } from '@/db/queries/workers';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const WORKER = '33333333-3333-4333-8333-333333333333';
const LAST_DAY = '2026-07-31';

/** Two distinct client objects, so a test can prove WHICH one a query got. The
 *  service one also answers the direct table reads/writes these actions make:
 *  every builder call returns itself and awaiting resolves `state.row`. */
const clients = vi.hoisted(() => {
  const state = { row: { status: 'active' } as Record<string, unknown> | null };
  const chain = () => {
    const c: Record<string, unknown> = {
      // biome-ignore lint/suspicious/noThenProperty: a supabase query builder is awaitable at every step — that is the thing being stubbed
      then: (resolve: (v: unknown) => void) => resolve({ data: state.row, error: null }),
    };
    for (const k of ['select', 'update', 'eq', 'neq', 'maybeSingle']) c[k] = () => c;
    return c;
  };
  return { rls: { tag: 'rls' }, service: { tag: 'service', from: () => chain() }, state };
});
const q = vi.hoisted(() => ({
  fetchWorkerLinks: vi.fn(),
  endEngagement: vi.fn(),
  setWorkerStatus: vi.fn(),
  clearWorkerTools: vi.fn(),
}));
const logEvent = vi.hoisted(() => vi.fn());
const admin = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/db/queries/workers', () => q);
vi.mock('@/db/clients/server', () => ({ createServerSupabase: async () => clients.rls }));
vi.mock('@/db/clients/service', () => ({ createServiceClient: () => clients.service }));
vi.mock('@/server/auth/admin', () => ({ getCurrentAdmin: async () => admin.current }));
vi.mock('@/server/audit', () => ({ logEvent }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// Imported by the action module but unused on these paths.
vi.mock('@/server/actions/payroll', () => ({ saveRate: vi.fn() }));
vi.mock('@/server/actions/portal-admin', () => ({ createPortalLogin: vi.fn() }));
vi.mock('@/db/queries/invoicing', () => ({ fetchActiveClients: vi.fn() }));

const { endAssignment, saveWorkerCompanyLink, terminateContractor } = await import(
  '@/server/actions/contractors'
);

const scopedTo = (...companyIds: string[]) => {
  admin.current = { email: 'scoped@abckidsny.com', companyIds, isOwner: false };
};
const links = (...rows: WorkerLink[]) => {
  q.fetchWorkerLinks.mockResolvedValue(rows);
};

beforeEach(() => {
  vi.clearAllMocks();
  q.endEngagement.mockResolvedValue({ endedCompanyIds: [CO_A] });
  clients.state.row = { status: 'active' };
});

describe('terminateContractor', () => {
  // #82: the guard read the link list through the caller's own client, so the
  // list was a subset of admin.companyIds by construction and the branch was
  // unreachable. The scoped admin then ended only the links RLS showed them
  // while workers.status went 'ended' globally.
  it('reads the company list on the service client, so the cross-company guard can fire', async () => {
    scopedTo(CO_A);
    links({ companyId: CO_A, status: 'active' }, { companyId: CO_B, status: 'active' });

    const res = await terminateContractor({ workerId: WORKER, lastDay: LAST_DAY });

    expect(q.fetchWorkerLinks).toHaveBeenCalledWith(clients.service, WORKER);
    expect(res.ok).toBe(false);
    expect(q.endEngagement).not.toHaveBeenCalled();
    expect(q.setWorkerStatus).not.toHaveBeenCalled();
  });

  it('terminates when every company is in the admin scope', async () => {
    scopedTo(CO_A, CO_B);
    links({ companyId: CO_A, status: 'active' }, { companyId: CO_B, status: 'active' });

    expect((await terminateContractor({ workerId: WORKER, lastDay: LAST_DAY })).ok).toBe(true);
    expect(q.setWorkerStatus).toHaveBeenCalledWith(clients.rls, WORKER, 'ended');
  });

  // #93C: with a NULL company_id the audit_log INSERT policy collapses to
  // is_owner(), so the row was rejected — no trail for the one action that
  // legally needs one, precisely when the actor is least privileged.
  it('stamps a company on the audit row, or RLS drops it for a scoped admin', async () => {
    scopedTo(CO_A);
    links({ companyId: CO_A, status: 'active' });

    await terminateContractor({ workerId: WORKER, lastDay: LAST_DAY });

    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'contractor.terminated', companyId: CO_A }),
    );
  });

  // Every write below the guard skips an already-ended row, so this returned
  // `ok` while doing nothing — and logged an audit row naming a last day that
  // was never written anywhere.
  it('refuses a contractor who is already terminated', async () => {
    scopedTo(CO_A);
    links({ companyId: CO_A, status: 'ended' });
    clients.state.row = { status: 'ended' };

    expect(await terminateContractor({ workerId: WORKER, lastDay: LAST_DAY })).toEqual({
      ok: false,
      error: 'That contractor has already been terminated.',
    });
    expect(q.endEngagement).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });
});

// #81: this was a plain-typed action spreading `status` into a service-role
// (RLS-bypassing) update. TypeScript is erased at runtime, so 'ended' — a valid
// DB enum value — was one forged POST away from a link with no `ended_on`: no
// rate close, no coverage close, and invisible to the time-import gate.
describe('saveWorkerCompanyLink', () => {
  const args = {
    workerId: WORKER,
    companyId: CO_A,
    role: 'Billing Specialist',
    billRateUsd: 25,
    sessionRateUsd: null,
    contract: 'FT',
    payBasis: null,
  };

  it("rejects status:'ended' at the trust boundary", async () => {
    scopedTo(CO_A);

    expect((await saveWorkerCompanyLink({ ...args, status: 'ended' })).ok).toBe(false);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('accepts the same payload with the status omitted', async () => {
    scopedTo(CO_A);

    expect((await saveWorkerCompanyLink(args)).ok).toBe(true);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ companyId: CO_A }));
  });
});

describe('endAssignment', () => {
  const args = { workerId: WORKER, companyId: CO_A, lastDay: LAST_DAY };

  // #83: the remaining-active count ran through RLS, so a company the admin
  // cannot see counted as zero and a contractor still working there was flipped
  // 'inactive' globally — zeroing their health allowance and 13th month.
  it('counts the remaining links on the service client, not the caller’s', async () => {
    scopedTo(CO_A);
    links({ companyId: CO_A, status: 'ended' }, { companyId: CO_B, status: 'active' });

    expect((await endAssignment(args)).ok).toBe(true);
    expect(q.fetchWorkerLinks).toHaveBeenCalledWith(clients.service, WORKER);
    expect(q.setWorkerStatus).not.toHaveBeenCalled();
  });

  it('drops the worker to inactive only when no link anywhere is still active', async () => {
    scopedTo(CO_A);
    links({ companyId: CO_A, status: 'ended' }, { companyId: CO_B, status: 'inactive' });

    await endAssignment(args);

    expect(q.setWorkerStatus).toHaveBeenCalledWith(clients.rls, WORKER, 'inactive');
  });

  // #88 path 1: a stale tab ending an assignment that already ended used to run
  // the whole tail, dropping a terminated contractor to 'inactive'.
  it('refuses when nothing was open to end', async () => {
    scopedTo(CO_A);
    links({ companyId: CO_A, status: 'ended' });
    q.endEngagement.mockResolvedValue({ endedCompanyIds: [] });

    expect(await endAssignment(args)).toEqual({
      ok: false,
      error: 'That assignment has already ended.',
    });
    expect(q.setWorkerStatus).not.toHaveBeenCalled();
  });
});
