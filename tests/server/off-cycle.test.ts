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

const {
  addOffCycleEntry,
  addSalariedCatchUpEntry,
  paySessionsIntoOffCycleBatch,
  paySessionsIntoOpenDraft,
  paySessionsIntoPeriod,
  removeOffCycleEntry,
} = await import('@/server/off-cycle');
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

// The OPEN target period the catch-up is paid on (the original is pp-1).
const NEXT_START = '2026-07-16';
const NEXT_END = '2026-07-31';
const nextPeriod = (over: Record<string, unknown> = {}) =>
  period({
    id: 'pp-2',
    period_start: NEXT_START,
    period_end: NEXT_END,
    pay_date: '2026-08-15',
    ...over,
  });

const catchUpInput = (over: Record<string, unknown> = {}) =>
  ({
    companyId: COMPANY,
    periodStart: NEXT_START,
    periodEnd: NEXT_END,
    workerId: 'w-cara',
    originalPeriodDate: '2026-07-10',
    hours: 20,
    ...over,
  }) as Parameters<typeof addSalariedCatchUpEntry>[0];

describe('addSalariedCatchUpEntry', () => {
  const seedCatchUp = (): Tables => {
    const seed = seedBase();
    seed.workers = [worker('w-cara')];
    seed.worker_companies = [link('w-cara', 'FT')];
    seed.rates = [rate('w-cara', 10000)];
    // 80h approved in the ORIGINAL window; the locked run paid only 40h.
    seed.time_entries = [
      {
        id: 1,
        company_id: COMPANY,
        worker_id: 'w-cara',
        source_name: null,
        work_date: '2026-07-06',
        tracked_seconds: 40 * 3600,
        pto_seconds: 0,
        approval: 'approved',
      },
      {
        id: 2,
        company_id: COMPANY,
        worker_id: 'w-cara',
        source_name: null,
        work_date: '2026-07-13',
        tracked_seconds: 40 * 3600,
        pto_seconds: 0,
        approval: 'approved',
      },
    ];
    seed.pay_periods = [period({ state: 'locked' }), nextPeriod()];
    seed.payments = [
      {
        id: 'pay-orig',
        company_id: COMPANY,
        pay_period_id: 'pp-1',
        worker_id: 'w-cara',
        worked_hours: 40,
      },
    ];
    return seed;
  };

  it('RP-20 surgical branch: prices with the engine cap and updates only off_cycle/net in place', async () => {
    const seed = seedCatchUp();
    // The worker already has a row on the open target period — the rebuild
    // must NOT run; only off_cycle_php + net_php may change.
    seed.payments.push({
      id: 'pay-target',
      company_id: COMPANY,
      pay_period_id: 'pp-2',
      worker_id: 'w-cara',
      gross_php: 1000,
      net_php: 1000,
    });
    const { deps, tables } = mkDeps(seed);

    const res = await addSalariedCatchUpEntry(catchUpInput(), deps);

    // rate × (min(60/80,1) − min(40/80,1)) = ₱10,000 × 0.25
    expect(res).toEqual({ netPhp: 3500, amountPhp: 2500 });
    expect(tables.off_cycle_pay_items).toHaveLength(1);
    expect(tables.off_cycle_pay_items[0]).toMatchObject({
      pay_period_id: 'pp-2',
      basis: 'salaried_hours',
      session_id: null,
      work_date: END, // keyed on the ORIGINAL period's end
      units: 20,
      rate_php: 10000,
      amount_php: 2500,
      description: 'Catch-up FT hours · 2026-07-01 – 2026-07-15',
    });
    const target = tables.payments.find((p) => p.id === 'pay-target');
    expect(target).toMatchObject({ gross_php: 1000, off_cycle_php: 2500, net_php: 3500 });
  });

  it('refuses while the original period is still open', async () => {
    const seed = seedCatchUp();
    const orig = seed.pay_periods.find((p) => p.id === 'pp-1');
    if (orig) orig.state = 'open';
    const { deps } = mkDeps(seed);

    await expect(addSalariedCatchUpEntry(catchUpInput(), deps)).rejects.toThrow(
      'That period is still open — recalculate it instead of adding a catch-up.',
    );
  });
});

describe('paySessionsIntoOpenDraft', () => {
  const seedPs = (): Tables => {
    const seed = seedBase();
    seed.workers = [worker('w-ben')];
    seed.worker_companies = [link('w-ben', 'PS')];
    seed.rates = [rate('w-ben', 500)];
    return seed;
  };

  it('pays into the covering open draft, stamping the sessions', async () => {
    const seed = seedPs();
    seed.pay_periods = [period()];
    seed.service_sessions = [session('s-1', 'w-ben', '2026-07-06')];
    const { deps, tables } = mkDeps(seed);

    const res = await paySessionsIntoOpenDraft({ companyId: COMPANY, sessionIds: ['s-1'] }, deps);

    expect(res).toEqual({ paidInto: 'draft', count: 1, periodStart: START });
    expect(tables.off_cycle_pay_items[0]).toMatchObject({
      pay_period_id: 'pp-1',
      session_id: 's-1',
      description: 'Approved session',
    });
    expect(tables.service_sessions[0]).toMatchObject({
      paid_pay_period_id: 'pp-1',
      paid_payment_id: null,
    });
  });

  it('audit #001/#009: a selection spanning two drafts is rejected, no draft → none', async () => {
    const seed = seedPs();
    seed.pay_periods = [period(), nextPeriod()];
    seed.service_sessions = [
      session('s-1', 'w-ben', '2026-07-06'),
      session('s-2', 'w-ben', '2026-07-20'),
    ];
    const { deps, tables } = mkDeps(seed);

    await expect(
      paySessionsIntoOpenDraft({ companyId: COMPANY, sessionIds: ['s-1', 's-2'] }, deps),
    ).rejects.toThrow(/span more than one pay period/);
    expect(tables.off_cycle_pay_items).toHaveLength(0);

    // No open draft covers the date at all → soft 'none', still no write.
    tables.pay_periods.length = 0;
    const res = await paySessionsIntoOpenDraft({ companyId: COMPANY, sessionIds: ['s-1'] }, deps);
    expect(res).toEqual({ paidInto: 'none', count: 0 });
    expect(tables.off_cycle_pay_items).toHaveLength(0);
  });
});

describe('paySessionsIntoPeriod', () => {
  it('refuses a period that ended before the work happened', async () => {
    const seed = seedBase();
    seed.workers = [worker('w-ben')];
    seed.worker_companies = [link('w-ben', 'PS')];
    seed.rates = [rate('w-ben', 500)];
    seed.service_sessions = [session('s-1', 'w-ben', '2026-07-06')];
    const { deps } = mkDeps(seed);

    await expect(
      paySessionsIntoPeriod(
        { companyId: COMPANY, sessionIds: ['s-1'], periodStart: '2026-06-16' },
        deps,
      ),
    ).rejects.toThrow(
      'The 2026-06-16 – 2026-06-30 period ended before this work happened. Pay it in 2026-07-01 – 2026-07-15 or later.',
    );
  });

  it('defaults to the owning period, creating it open when missing', async () => {
    const seed = seedBase();
    seed.workers = [worker('w-ben')];
    seed.worker_companies = [link('w-ben', 'PS')];
    seed.rates = [rate('w-ben', 500)];
    seed.service_sessions = [session('s-1', 'w-ben', '2026-07-06')];
    const { deps, tables } = mkDeps(seed);

    const res = await paySessionsIntoPeriod({ companyId: COMPANY, sessionIds: ['s-1'] }, deps);

    expect(res).toEqual({ count: 1, periodStart: START });
    expect(tables.pay_periods).toHaveLength(1);
    expect(tables.pay_periods[0]).toMatchObject({
      period_start: START,
      period_end: END,
      state: 'open',
    });
    expect(tables.off_cycle_pay_items).toHaveLength(1);
    expect(tables.service_sessions[0]?.paid_at).toBeTruthy();
  });
});

describe('paySessionsIntoOffCycleBatch', () => {
  it('creates the batch and builds the row ledger-only', async () => {
    const seed = seedBase();
    seed.workers = [worker('w-ben')];
    seed.worker_companies = [link('w-ben', 'PS')];
    seed.rates = [rate('w-ben', 500)];
    seed.service_sessions = [session('s-1', 'w-ben', '2026-07-06')];
    const { deps, tables } = mkDeps(seed);

    const res = await paySessionsIntoOffCycleBatch(
      { companyId: COMPANY, sessionIds: ['s-1'] },
      deps,
    );

    expect(res.count).toBe(1);
    expect(tables.pay_periods).toHaveLength(1);
    expect(tables.pay_periods[0]).toMatchObject({ kind: 'off_cycle', state: 'open' });
    expect(tables.off_cycle_pay_items[0]).toMatchObject({
      pay_period_id: res.batchId,
      session_id: 's-1',
      amount_php: 500,
    });
    expect(tables.payments[0]).toMatchObject({ worker_id: 'w-ben', net_php: 500 });
  });
});

describe('removeOffCycleEntry', () => {
  const seedRemove = (): Tables => {
    const seed = seedBase();
    seed.workers = [worker('w-ben')];
    seed.worker_companies = [link('w-ben', 'PS')];
    seed.rates = [rate('w-ben', 500)];
    seed.pay_periods = [period()];
    seed.service_sessions = [
      session('s-1', 'w-ben', '2026-06-20', {
        paid_at: '2026-07-01T00:00:00Z',
        paid_pay_period_id: 'pp-1',
        paid_payment_id: null,
      }),
    ];
    seed.off_cycle_pay_items = [
      {
        id: 'oc-1',
        company_id: COMPANY,
        worker_id: 'w-ben',
        pay_period_id: 'pp-1',
        basis: 'per_session',
        session_id: 's-1',
        work_date: '2026-06-20',
        units: 1,
        rate_php: 500,
        amount_php: 500,
        description: 'test entry',
        created_at: '2026-07-01T00:00:00Z',
      },
    ];
    seed.payments = [
      {
        id: 'pay-ben',
        company_id: COMPANY,
        pay_period_id: 'pp-1',
        worker_id: 'w-ben',
        net_php: 500,
      },
    ];
    return seed;
  };

  it('deletes the ledger row, frees the session, and drops the now-empty draft row', async () => {
    const { deps, tables } = mkDeps(seedRemove());

    const res = await removeOffCycleEntry({ companyId: COMPANY, itemId: 'oc-1' }, deps);

    expect(res).toEqual({ netPhp: null });
    expect(tables.off_cycle_pay_items).toHaveLength(0);
    expect(tables.service_sessions[0]).toMatchObject({
      paid_at: null,
      paid_pay_period_id: null,
      paid_payment_id: null,
    });
    // No other payable activity → the worker's stale draft row is pruned.
    expect(tables.payments).toHaveLength(0);
  });

  it('refuses a locked period with the canonical copy', async () => {
    const seed = seedRemove();
    const p = seed.pay_periods.find((row) => row.id === 'pp-1');
    if (p) p.state = 'locked';
    const { deps, tables } = mkDeps(seed);

    await expect(removeOffCycleEntry({ companyId: COMPANY, itemId: 'oc-1' }, deps)).rejects.toThrow(
      'Period is locked — unlock it to remove off-cycle pay.',
    );
    expect(tables.off_cycle_pay_items).toHaveLength(1);
  });
});
