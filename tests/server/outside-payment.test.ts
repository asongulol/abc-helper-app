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
const { RecordOutsidePaymentSchema } = await import('@/types/schemas/payroll');
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
    designations: [],
    reference: 'BPI 000123',
    ...over,
  }) as Parameters<typeof recordOutsidePayment>[0];

describe('RecordOutsidePaymentSchema', () => {
  it("rejects over-allocation and an unnamed 'Other'; defaults designations to []", () => {
    // The action's trust boundary wants real UUIDs — unlike the fake's ids.
    const base = {
      companyId: '11111111-1111-4111-8111-111111111111',
      periodStart: START,
      periodEnd: END,
      workerId: '22222222-2222-4222-8222-222222222222',
      amountPhp: 12500,
      paidOn: '2026-07-20',
      payoutMethod: 'wise',
    };
    expect(RecordOutsidePaymentSchema.safeParse(base).success).toBe(true);
    const parsed = RecordOutsidePaymentSchema.parse({ ...base, designations: undefined });
    expect(parsed.designations).toEqual([]);
    expect(
      RecordOutsidePaymentSchema.safeParse({
        ...base,
        designations: [{ kind: 'backpay', amountPhp: 13000 }],
      }).success,
    ).toBe(false);
    expect(
      RecordOutsidePaymentSchema.safeParse({
        ...base,
        designations: [{ kind: 'other', amountPhp: 100 }],
      }).success,
    ).toBe(false);
  });
});

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
    // Born 'locked' (never open, so no recalc exposure), then synced to
    // 'paid' since every row is sent.
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

  it('slot taken by a PAID row → lands on a single-day batch naming the covered period', async () => {
    const seed = seedBase();
    seed.pay_periods = [period()];
    seed.payments = [{ id: 'pay-1', pay_period_id: 'pp-1', worker_id: 'w-ben', status: 'sent' }];
    const { deps, tables } = mkDeps(seed);

    const res = await recordOutsidePayment(input(), deps);

    expect(tables.pay_periods?.find((pp) => pp.id === res.periodId)).toMatchObject({
      period_start: '2026-07-20',
      period_end: '2026-07-20',
      pay_date: '2026-07-20',
      kind: 'off_cycle',
      state: 'paid',
    });
    expect(tables.payments?.find((r) => r.id === res.paymentId)).toMatchObject({
      pay_period_id: res.periodId,
      status: 'sent',
      note: 'Outside payment (recorded manually) — covers 2026-07-01 → 2026-07-15 — BPI 000123',
    });
    // The covered period's own row is untouched.
    expect(tables.payments?.find((r) => r.id === 'pay-1')?.pay_period_id).toBe('pp-1');
  });

  it('slot taken by an UNPAID row → refuses with the Mark-paid pointer', async () => {
    const seed = seedBase();
    seed.pay_periods = [period({ state: 'locked' })];
    seed.payments = [{ id: 'pay-1', pay_period_id: 'pp-1', worker_id: 'w-ben', status: 'draft' }];
    const { deps } = mkDeps(seed);

    await expect(recordOutsidePayment(input(), deps)).rejects.toThrow(/Mark paid/);
  });

  it('second outside payment for the same contractor on the same day → refuses', async () => {
    const seed = seedBase();
    seed.pay_periods = [
      period(),
      period({
        id: 'pp-day',
        period_start: '2026-07-20',
        period_end: '2026-07-20',
        pay_date: '2026-07-20',
        kind: 'off_cycle',
        state: 'paid',
      }),
    ];
    seed.payments = [
      { id: 'pay-1', pay_period_id: 'pp-1', worker_id: 'w-ben', status: 'sent' },
      { id: 'pay-2', pay_period_id: 'pp-day', worker_id: 'w-ben', status: 'sent' },
    ];
    const { deps } = mkDeps(seed);

    await expect(recordOutsidePayment(input(), deps)).rejects.toThrow(/one per contractor per day/);
  });

  it('designations split onto the native columns; remainder stays base pay; note carries it all', async () => {
    const { deps, tables } = mkDeps(seedBase());

    const res = await recordOutsidePayment(
      input({
        transferRef: '987654321',
        designations: [
          { kind: 'backpay', amountPhp: 4000, note: 'June underpay' },
          { kind: 'thirteenth_month', amountPhp: 3000 },
          { kind: 'health_allowance', amountPhp: 2000 },
          { kind: 'lunch', amountPhp: 500 },
          { kind: 'pto', amountPhp: 1000 },
          { kind: 'other', label: 'Gear', amountPhp: 500 },
        ],
      }),
      deps,
    );

    const row = tables.payments?.find((r) => r.id === res.paymentId);
    expect(row).toMatchObject({
      net_php: 12500,
      gross_php: 1500, // 12,500 − 11,000 designated
      thirteenth_month_php: 3000,
      health_allowance_php: 2000,
      pdd_lunch_php: 500,
      misc_items: [
        { kind: 'other_earns', label: 'Backpay', amount: 4000 },
        { kind: 'other_earns', label: 'PTO', amount: 1000 },
        { kind: 'other_earns', label: 'Gear', amount: 500 },
      ],
    });
    const note = String(row?.note);
    expect(note).toContain('Backpay ₱4,000 (June underpay)');
    expect(note).toContain('13th Month ₱3,000');
    expect(note).toContain('Transfer ref 987654321');
    expect(note).toContain('BPI 000123');
  });

  it('designations exceeding the amount → refuses (service backstop; schema also rejects)', async () => {
    const { deps } = mkDeps(seedBase());

    await expect(
      recordOutsidePayment(input({ designations: [{ kind: 'backpay', amountPhp: 13000 }] }), deps),
    ).rejects.toThrow(/exceed/);
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
