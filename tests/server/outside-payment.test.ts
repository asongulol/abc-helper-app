import { describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type Tables } from '../fixtures/supabase-fake';

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

const { recordOutsidePayment } = await import('@/server/outside-payment');
type PayrollDeps = import('@/server/payroll').PayrollDeps;

const COMPANY = 'c-1';
const START = '2026-07-01';
const END = '2026-07-15';

const worker = (id: string) => ({
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
});
const link = (workerId: string) => ({
  worker_id: workerId,
  company_id: COMPANY,
  contract: 'PS',
  pay_basis: null,
  hubstaff_name: null,
  status: 'active',
});
const period = (over: Record<string, unknown> = {}) => ({
  id: 'pp-1',
  company_id: COMPANY,
  period_start: START,
  period_end: END,
  pay_date: '2026-07-31',
  state: 'paid',
  kind: 'regular',
  ...over,
});

const seedBase = (): Tables => ({
  companies: [{ id: COMPANY, holidays_config: {} }],
  workers: [worker('w-ben')],
  worker_companies: [link('w-ben')],
  pay_periods: [],
  payments: [],
});

const mkDeps = (seed: Tables): { deps: PayrollDeps; tables: Tables } => {
  const { client, tables } = fakeSupabase(seed);
  return { deps: { db: client, serviceDb: client }, tables };
};

const input = (over: Record<string, unknown> = {}) =>
  ({
    companyId: COMPANY,
    periodStart: START,
    periodEnd: END,
    workerId: 'w-ben',
    amountPhp: 12500,
    paidOn: '2026-07-20',
    payoutMethod: 'wise',
    reference: 'BPI 000123',
    ...over,
  }) as Parameters<typeof recordOutsidePayment>[0];

describe('recordOutsidePayment', () => {
  it('creates a missing period, inserts the sent row, and closes the period as paid', async () => {
    const { deps, tables } = mkDeps(seedBase());

    const res = await recordOutsidePayment(input(), deps);

    expect(tables.payments).toHaveLength(1);
    expect(tables.payments?.[0]).toMatchObject({
      id: res.paymentId,
      pay_period_id: res.periodId,
      worker_id: 'w-ben',
      status: 'sent',
      paid_at: '2026-07-20',
      payout_method: 'wise',
      gross_php: 12500,
      net_php: 12500,
      note: 'Outside payment (recorded manually) — BPI 000123',
    });
    // Created open → locked → all rows sent → paid. Never left open for a
    // recalc to prune.
    expect(tables.pay_periods?.[0]).toMatchObject({
      id: res.periodId,
      pay_date: '2026-07-31',
      state: 'paid',
    });
  });

  it('appends to an existing locked period and leaves it locked while drafts remain', async () => {
    const seed = seedBase();
    seed.workers?.push(worker('w-ana'));
    seed.worker_companies?.push(link('w-ana'));
    seed.pay_periods = [period({ state: 'locked' })];
    seed.payments = [
      { id: 'pay-draft', pay_period_id: 'pp-1', worker_id: 'w-ana', status: 'draft' },
    ];
    const { deps, tables } = mkDeps(seed);

    await recordOutsidePayment(input(), deps);

    expect(tables.payments).toHaveLength(2);
    expect(tables.pay_periods?.[0]).toMatchObject({ state: 'locked' });
  });

  it('refuses an open period — Calculate owns those', async () => {
    const seed = seedBase();
    seed.pay_periods = [period({ state: 'open' })];
    const { deps } = mkDeps(seed);

    await expect(recordOutsidePayment(input(), deps)).rejects.toThrow(/open draft/);
  });

  it('refuses a worker who already has a row on the period', async () => {
    const seed = seedBase();
    seed.pay_periods = [period()];
    seed.payments = [{ id: 'pay-1', pay_period_id: 'pp-1', worker_id: 'w-ben', status: 'sent' }];
    const { deps } = mkDeps(seed);

    await expect(recordOutsidePayment(input(), deps)).rejects.toThrow(/already has a row/);
  });

  it('refuses an off-roster worker, a non-semi-monthly window, and a future paid date', async () => {
    const { deps } = mkDeps(seedBase());

    await expect(recordOutsidePayment(input({ workerId: 'w-ghost' }), deps)).rejects.toThrow(
      /roster/,
    );
    await expect(
      recordOutsidePayment(input({ periodStart: '2026-07-02', periodEnd: '2026-07-16' }), deps),
    ).rejects.toThrow(/semi-monthly/);
    await expect(recordOutsidePayment(input({ paidOn: '2999-01-01' }), deps)).rejects.toThrow(
      /future/,
    );
  });
});
