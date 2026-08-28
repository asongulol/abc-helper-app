import { describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type Tables } from '../fixtures/supabase-fake';

// The seam under test: every fn takes deps = {db, serviceDb}. The real client
// factories throw so a code path that forgets to thread deps fails loudly.
vi.mock('@/db/clients/server', () => ({
  createServerSupabase: async () => {
    throw new Error('test must pass PayrollDeps');
  },
}));
vi.mock('@/db/clients/service', () => ({
  createServiceClient: () => {
    throw new Error('test must pass PayrollDeps');
  },
}));
vi.mock('@/server/audit', () => ({ logEvent: async () => {} }));

const { addOffCycleEntry } = await import('@/server/off-cycle');
type PayrollDeps = import('@/server/payroll').PayrollDeps;

const COMPANY = 'c-1';
// Same fixed window as payroll.test.ts: 2026-07-01..15 ⇒ FT expected = 80h.
const START = '2026-07-01';
const END = '2026-07-15';

const worker = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  first_name: id,
  middle_name: null,
  last_name: 'Test',
  hire_date: '2025-01-01',
  status: 'active',
  payout_method: 'wise',
  health_allowance_eligible: false,
  health_allowance_date: null,
  thirteenth_month_eligible: false,
  ...over,
});
const link = (workerId: string, contract: string, payBasis: string | null = null) => ({
  worker_id: workerId,
  company_id: COMPANY,
  contract,
  pay_basis: payBasis,
  hubstaff_name: null,
  status: 'active',
});
const rate = (workerId: string, amountPhp: number) => ({
  worker_id: workerId,
  company_id: COMPANY,
  amount_php: amountPhp,
  effective_start: '2024-01-01',
  effective_end: null,
});
const period = (over: Record<string, unknown> = {}) => ({
  id: 'pp-1',
  company_id: COMPANY,
  period_start: START,
  period_end: END,
  pay_date: '2026-07-31',
  state: 'open',
  kind: 'regular',
  ...over,
});
const session = (
  id: string,
  workerId: string,
  date: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  worker_id: workerId,
  session_date: date,
  units: 1,
  approval: 'approved',
  paid_at: null,
  paid_pay_period_id: null,
  paid_payment_id: null,
  ...over,
});

const seedBase = (): Tables => ({
  companies: [{ id: COMPANY, holidays_config: {} }],
  workers: [],
  worker_companies: [],
  rates: [],
  time_entries: [],
  service_sessions: [],
  pay_periods: [],
  payments: [],
  off_cycle_pay_items: [],
});

const mkDeps = (seed: Tables): { deps: PayrollDeps; tables: Tables } => {
  const { client, tables } = fakeSupabase(seed);
  return { deps: { db: client, serviceDb: client }, tables };
};

const addInput = (over: Record<string, unknown> = {}) =>
  ({
    companyId: COMPANY,
    periodStart: START,
    periodEnd: END,
    workerId: 'w-ben',
    basis: 'per_session',
    description: 'test entry',
    mode: 'pick',
    sessionIds: ['s-1'],
    ...over,
  }) as Parameters<typeof addOffCycleEntry>[0];

describe('addOffCycleEntry', () => {
  it('pick mode: writes the ledger row, stamps the session paid, rebuilds the draft', async () => {
    const seed = seedBase();
    seed.workers = [worker('w-ben')];
    seed.worker_companies = [link('w-ben', 'PS')];
    seed.rates = [rate('w-ben', 500)];
    seed.pay_periods = [period()];
    // Session dated OUTSIDE the window — the whole point of the ledger.
    seed.service_sessions = [session('s-1', 'w-ben', '2026-06-20')];
    const { deps, tables } = mkDeps(seed);

    const res = await addOffCycleEntry(addInput(), deps);

    expect(res).toEqual({ netPhp: 500, count: 1 });
    expect(tables.off_cycle_pay_items).toHaveLength(1);
    expect(tables.off_cycle_pay_items[0]).toMatchObject({
      pay_period_id: 'pp-1',
      worker_id: 'w-ben',
      basis: 'per_session',
      session_id: 's-1',
      work_date: '2026-06-20',
      units: 1,
      rate_php: 500,
      amount_php: 500,
      description: 'test entry',
    });
    // Stamped with the period but NO payment id (that marks a ledger hold —
    // unlockRun must not release it).
    expect(tables.service_sessions[0]).toMatchObject({
      paid_pay_period_id: 'pp-1',
      paid_payment_id: null,
    });
    expect(tables.service_sessions[0]?.paid_at).toBeTruthy();
    expect(tables.payments).toHaveLength(1);
    expect(tables.payments[0]).toMatchObject({ worker_id: 'w-ben', net_php: 500 });
  });

  it('pick refusal: an already-paid session throws and writes nothing', async () => {
    const seed = seedBase();
    seed.workers = [worker('w-ben')];
    seed.worker_companies = [link('w-ben', 'PS')];
    seed.rates = [rate('w-ben', 500)];
    seed.pay_periods = [period()];
    seed.service_sessions = [
      session('s-1', 'w-ben', '2026-06-20', { paid_at: '2026-06-30T00:00:00Z' }),
    ];
    const { deps, tables } = mkDeps(seed);

    await expect(addOffCycleEntry(addInput(), deps)).rejects.toThrow(
      'A selected session has already been paid.',
    );
    expect(tables.off_cycle_pay_items).toHaveLength(0);
    expect(tables.payments).toHaveLength(0);
  });

  it('refuses a basis mismatch with the contractor’s actual model', async () => {
    const seed = seedBase();
    seed.workers = [worker('w-ana')];
    seed.worker_companies = [link('w-ana', 'PH')];
    seed.pay_periods = [period()];
    const { deps } = mkDeps(seed);

    await expect(addOffCycleEntry(addInput({ workerId: 'w-ana' }), deps)).rejects.toThrow(
      'This contractor is paid per-hour, not per-session.',
    );
  });

  it('manual mode: units × rate when no explicit amount; refuses without either', async () => {
    const seed = seedBase();
    seed.workers = [worker('w-ana')];
    seed.worker_companies = [link('w-ana', 'PH')];
    seed.rates = [rate('w-ana', 100)];
    seed.pay_periods = [period()];
    const { deps, tables } = mkDeps(seed);
    const manual = {
      workerId: 'w-ana',
      basis: 'per_hour',
      mode: 'manual',
      sessionIds: undefined,
      workDate: '2026-06-20',
      units: 3,
    };

    const res = await addOffCycleEntry(addInput(manual), deps);

    expect(res).toEqual({ netPhp: 300, count: 1 });
    expect(tables.off_cycle_pay_items[0]).toMatchObject({
      basis: 'per_hour',
      session_id: null,
      work_date: '2026-06-20',
      units: 3,
      rate_php: 100,
      amount_php: 300,
    });

    // No rate on file and no explicit amount → refuse with the date in the copy.
    tables.rates.length = 0;
    await expect(addOffCycleEntry(addInput(manual), deps)).rejects.toThrow(
      'No rate is set for 2026-06-20. Set a rate or enter an amount.',
    );
  });

  it('refuses a locked period with the canonical copy', async () => {
    const seed = seedBase();
    seed.workers = [worker('w-ben')];
    seed.worker_companies = [link('w-ben', 'PS')];
    seed.pay_periods = [period({ state: 'locked' })];
    const { deps } = mkDeps(seed);

    await expect(addOffCycleEntry(addInput(), deps)).rejects.toThrow(
      'Period is locked — unlock it to add off-cycle pay.',
    );
  });
});
