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

const { calculateDraft, recomputeWorkerDraft, reconcileApprovedTime, salariedCatchUpCandidates } =
  await import('@/server/payroll');
type PayrollDeps = import('@/server/payroll').PayrollDeps;

const COMPANY = 'c-1';
// 2026-07-01..15: 11 weekdays − July 4 observed Fri Jul 3 ⇒ 10 working days,
// FT expected = 80h. Fixed dates keep every number below exact.
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
const link = (workerId: string, contract: string) => ({
  worker_id: workerId,
  company_id: COMPANY,
  contract,
  pay_basis: null,
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
const entry = (id: number, workerId: string, workDate: string, hours: number) => ({
  id,
  company_id: COMPANY,
  worker_id: workerId,
  source_name: null,
  work_date: workDate,
  tracked_seconds: hours * 3600,
  pto_seconds: 0,
  approval: 'approved',
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

const draftInput = (over: Record<string, unknown> = {}) =>
  ({
    companyId: COMPANY,
    periodStart: START,
    periodEnd: END,
    payDate: '2026-07-31',
    includeHealthAllowance: true,
    includeThirteenth: false,
    ...over,
  }) as Parameters<typeof calculateDraft>[0];

describe('calculateDraft', () => {
  it('off-cycle batch builds from the ledger only: no tracked hours, no HA', async () => {
    const seed = seedBase();
    // Ben: HA-eligible per-session worker whose anniversary lands in the window
    // — HA must STILL be 0 because an off-cycle batch never pays allowances.
    seed.workers = [
      worker('w-ben', { health_allowance_eligible: true, health_allowance_date: '2020-07-20' }),
      worker('w-ana'),
    ];
    seed.worker_companies = [link('w-ben', 'PS'), link('w-ana', 'PH')];
    seed.rates = [rate('w-ben', 500), rate('w-ana', 100)];
    // Ana tracked 10h INSIDE the batch window — must be ignored (ledger only).
    seed.time_entries = [entry(1, 'w-ana', '2026-07-20', 10)];
    seed.pay_periods = [
      {
        id: 'pp-off',
        company_id: COMPANY,
        period_start: '2026-07-20',
        period_end: '2026-07-20',
        pay_date: '2026-07-20',
        state: 'open',
        kind: 'off_cycle',
      },
    ];
    seed.off_cycle_pay_items = [
      {
        id: 'oc-1',
        company_id: COMPANY,
        worker_id: 'w-ben',
        pay_period_id: 'pp-off',
        basis: 'per_session',
        session_id: null,
        work_date: null,
        units: 3,
        rate_php: 500,
        amount_php: 1500,
        description: null,
        created_at: '2026-07-20T00:00:00Z',
      },
    ];
    const { deps, tables } = mkDeps(seed);

    const result = await calculateDraft(
      draftInput({ periodStart: '2026-07-20', periodEnd: '2026-07-20' }),
      deps,
    );

    expect(result.rows.map((r) => r.workerId)).toEqual(['w-ben']);
    expect(result.rows[0]?.result.healthAllowance).toBe(0);
    const persisted = tables.payments;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      worker_id: 'w-ben',
      gross_php: 1500, // per-unit fold: the ledger total IS the session gross
      off_cycle_php: 0,
      health_allowance_php: 0,
      net_php: 1500,
      units: 3,
    });
  });

  it('F5: recalc prunes the payment row of a worker whose approved time is gone', async () => {
    const seed = seedBase();
    seed.workers = [worker('w-ana'), worker('w-ben')];
    seed.worker_companies = [link('w-ana', 'PH'), link('w-ben', 'PS')];
    seed.rates = [rate('w-ana', 100), rate('w-ben', 500)];
    seed.time_entries = [entry(1, 'w-ana', '2026-07-06', 10)];
    seed.pay_periods = [
      {
        id: 'pp-1',
        company_id: COMPANY,
        period_start: START,
        period_end: END,
        pay_date: '2026-07-31',
        state: 'open',
        kind: 'regular',
      },
    ];
    seed.payments = [
      { id: 'pay-ana', company_id: COMPANY, pay_period_id: 'pp-1', worker_id: 'w-ana' },
      // Ben's time was retracted since the last calculate — row must go.
      { id: 'pay-ben', company_id: COMPANY, pay_period_id: 'pp-1', worker_id: 'w-ben' },
    ];
    const { deps, tables } = mkDeps(seed);

    const result = await calculateDraft(draftInput(), deps);

    expect(result.priorSnapshot).toHaveLength(2); // captured BEFORE the prune
    expect(tables.payments).toHaveLength(1);
    // Upsert merged onto the existing row (same id), 10h × ₱100 = ₱1000.
    expect(tables.payments[0]).toMatchObject({ id: 'pay-ana', worker_id: 'w-ana', net_php: 1000 });
  });

  it('F6: prior rows are snapshotted verbatim onto the period before the rewrite', async () => {
    const seed = seedBase();
    seed.workers = [worker('w-ana')];
    seed.worker_companies = [link('w-ana', 'PH')];
    seed.rates = [rate('w-ana', 100)];
    seed.time_entries = [entry(1, 'w-ana', '2026-07-06', 10)];
    seed.pay_periods = [
      {
        id: 'pp-1',
        company_id: COMPANY,
        period_start: START,
        period_end: END,
        pay_date: '2026-07-31',
        state: 'open',
        kind: 'regular',
      },
    ];
    seed.payments = [
      {
        id: 'pay-ana',
        company_id: COMPANY,
        pay_period_id: 'pp-1',
        worker_id: 'w-ana',
        bonus_php: 3000,
        note: 'hand-edited',
      },
    ];
    const { deps, tables } = mkDeps(seed);

    const result = await calculateDraft(draftInput(), deps);

    expect(result.priorSnapshot).toHaveLength(1);
    expect(result.priorSnapshot[0]).toMatchObject({
      id: 'pay-ana',
      bonus_php: 3000,
      note: 'hand-edited',
    });
    // Parked on the period (RP-23) so the undo never trusts client rows…
    expect(tables.pay_periods[0]?.prior_payments).toEqual(result.priorSnapshot);
    // …and the full recalc itself discards the manual bonus (that's what undo is for).
    expect(tables.payments[0]?.bonus_php).toBe(0);
  });

  it('RP-29: warns about the other period this year that already accrued the 13th', async () => {
    const seed = seedBase();
    seed.workers = [worker('w-cara', { thirteenth_month_eligible: true })];
    seed.worker_companies = [link('w-cara', 'FT')];
    seed.rates = [rate('w-cara', 10000)];
    seed.time_entries = [entry(1, 'w-cara', '2026-07-06', 8)];
    seed.pay_periods = [
      {
        id: 'pp-0',
        company_id: COMPANY,
        period_start: '2026-06-16',
        period_end: '2026-06-30',
        pay_date: '2026-07-15',
        state: 'locked',
        kind: 'regular',
        include_13: true,
      },
    ];
    const { deps } = mkDeps(seed);

    const result = await calculateDraft(draftInput({ includeThirteenth: true }), deps);

    expect(result.thirteenthAlsoOn).toEqual(['2026-06-16 → 2026-06-30']);
  });
});

describe('recomputeWorkerDraft', () => {
  it('RP-20: replays the period flags and keeps the manual bonus', async () => {
    const seed = seedBase();
    // Cara is eligible for BOTH allowances, anniversary inside the window —
    // but the period's Calculate ran with HA off / 13th on, so the single-row
    // rebuild must reproduce exactly that, not the hardcoded defaults.
    seed.workers = [
      worker('w-cara', {
        health_allowance_eligible: true,
        health_allowance_date: '2020-07-10',
        thirteenth_month_eligible: true,
      }),
    ];
    seed.worker_companies = [link('w-cara', 'FT')];
    seed.rates = [rate('w-cara', 10000)];
    seed.time_entries = [entry(1, 'w-cara', '2026-07-06', 8)];
    seed.pay_periods = [
      {
        id: 'pp-1',
        company_id: COMPANY,
        period_start: START,
        period_end: END,
        pay_date: '2026-07-31',
        state: 'open',
        kind: 'regular',
        include_ha: false,
        include_13: true,
      },
    ];
    seed.payments = [
      {
        id: 'pay-cara',
        company_id: COMPANY,
        pay_period_id: 'pp-1',
        worker_id: 'w-cara',
        bonus_php: 500,
      },
    ];
    const { deps, tables } = mkDeps(seed);

    const res = await recomputeWorkerDraft(
      {
        companyId: COMPANY,
        periodId: 'pp-1',
        periodStart: START,
        periodEnd: END,
        workerId: 'w-cara',
      },
      deps,
    );

    const row = tables.payments[0];
    expect(row).toMatchObject({
      id: 'pay-cara',
      health_allowance_php: 0, // eligible + anniversary in window, but the run had HA off
      gross_php: 1000, // 8h / 80 expected × ₱10,000
      bonus_php: 500, // manual column survives the rebuild
    });
    expect(Number(row?.thirteenth_month_php)).toBeGreaterThan(0); // the run had 13th on
    expect(res.netPhp).toBe(row?.net_php);
  });
});

describe('reconcileApprovedTime', () => {
  it('is a no-op once every approved worker is on the batch', async () => {
    const seed = seedBase();
    seed.workers = [worker('w-ana')];
    seed.worker_companies = [link('w-ana', 'PH')];
    seed.rates = [rate('w-ana', 100)];
    seed.time_entries = [entry(1, 'w-ana', '2026-07-06', 10)];
    seed.pay_periods = [
      {
        id: 'pp-1',
        company_id: COMPANY,
        period_start: START,
        period_end: END,
        pay_date: '2026-07-31',
        state: 'open',
        kind: 'regular',
      },
    ];
    seed.payments = [
      {
        id: 'pay-ana',
        company_id: COMPANY,
        pay_period_id: 'pp-1',
        worker_id: 'w-ana',
        net_php: 1000,
      },
    ];
    const { deps, tables } = mkDeps(seed);
    const before = structuredClone(tables.payments);

    const res = await reconcileApprovedTime(
      { companyId: COMPANY, periodStart: START, periodEnd: END },
      deps,
    );

    expect(res).toEqual({ workers: 0 });
    expect(tables.payments).toEqual(before); // two reads, zero writes
  });
});

describe('salariedCatchUpCandidates', () => {
  it('prices leftover hours with the strict engine cap, net of prior catch-ups', async () => {
    const seed = seedBase();
    seed.workers = [worker('w-cara'), worker('w-ana')];
    seed.worker_companies = [link('w-cara', 'FT'), link('w-ana', 'PH')];
    seed.rates = [rate('w-cara', 10000), rate('w-ana', 100)];
    // 80h approved in the window (= 100% of FT expected) …
    seed.time_entries = [
      entry(1, 'w-cara', '2026-07-06', 40),
      entry(2, 'w-cara', '2026-07-13', 40),
      entry(3, 'w-ana', '2026-07-06', 10), // per-hour worker: never a candidate
    ];
    seed.pay_periods = [
      {
        id: 'pp-1',
        company_id: COMPANY,
        period_start: START,
        period_end: END,
        pay_date: '2026-07-31',
        state: 'locked',
        kind: 'regular',
      },
    ];
    // …the locked run paid 40h, and 20h were already caught up on the ledger.
    seed.payments = [
      {
        id: 'pay-cara',
        company_id: COMPANY,
        pay_period_id: 'pp-1',
        worker_id: 'w-cara',
        worked_hours: 40,
      },
    ];
    seed.off_cycle_pay_items = [
      {
        id: 'oc-1',
        company_id: COMPANY,
        worker_id: 'w-cara',
        pay_period_id: 'pp-2',
        basis: 'salaried_hours',
        session_id: null,
        work_date: END, // catch-up rows key on the ORIGINAL period's end
        units: 20,
        rate_php: null,
        amount_php: 2500,
        description: null,
        created_at: '2026-08-01T00:00:00Z',
      },
    ];
    const { deps } = mkDeps(seed);

    const candidates = await salariedCatchUpCandidates(
      { companyId: COMPANY, periodId: 'pp-1', periodStart: START, periodEnd: END },
      deps,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      workerId: 'w-cara',
      expectedHours: 80,
      approvedHours: 80,
      paidHours: 40,
      caughtUpHours: 20,
      leftoverHours: 20,
      rateCentavos: 1_000_000,
      // rate × (min(80/80,1) − min(60/80,1)) = ₱10,000 × 0.25
      amountCentavos: 250_000,
    });
  });
});
