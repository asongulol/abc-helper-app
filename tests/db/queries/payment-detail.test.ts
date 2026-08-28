import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { fetchPaymentDetail } from '@/db/queries/payroll';
import { fetchOwnPayments } from '@/db/queries/portal';
import type { Database } from '@/db/types';
import { fakeSupabase, type Tables } from '../../fixtures/supabase-fake';

const COMPANY = 'c-1';
const WORKER = 'w-1';
const PERIOD = 'pp-1';
const PAYMENT = '00000000-0000-4000-8000-000000000001';

const seed = (): Tables => ({
  companies: [{ id: COMPANY, name: 'ABC Kids' }],
  workers: [{ id: WORKER, first_name: 'Maria', middle_name: null, last_name: 'Santos' }],
  pay_periods: [
    {
      id: PERIOD,
      company_id: COMPANY,
      period_start: '2026-07-01',
      period_end: '2026-07-15',
      pay_date: '2026-07-30',
      state: 'locked',
    },
  ],
  payments: [
    {
      id: PAYMENT,
      worker_id: WORKER,
      company_id: COMPANY,
      pay_period_id: PERIOD,
      gross_php: 28054.69,
      health_allowance_php: 1000,
      thirteenth_month_php: 0,
      pdd_lunch_php: 0,
      bonus_php: 0,
      deduction_php: 0,
      off_cycle_php: 0,
      misc_items: [{ kind: 'deduction', label: 'Laptop', amount: 500 }],
      net_php: 28554.69,
      payout_method: 'wise',
      payout_currency: 'PHP',
      payout_amount: 28554.69,
      fx_rate: 56.2,
      wise_transfer_id: '2276187411',
      status: 'sent',
      paid_at: '2026-07-28T00:00:00Z',
      note: null,
      worked_hours: 81.05,
      expected_hours: 86.67,
      performance_ratio: null,
      rate_php: 30000,
      computed_gross_php: null,
      units: null,
      contract: 'FT',
      pay_basis: 'monthly',
    },
  ],
});

/** Capture every select-list string the code under test sends the client. */
const withSelectSpy = (client: SupabaseClient<Database>): string[] => {
  const selects: string[] = [];
  const orig = client.from.bind(client);
  (client as { from: unknown }).from = (table: string) => {
    const q = orig(table) as { select: (...a: unknown[]) => unknown };
    const os = q.select.bind(q);
    q.select = (...a: unknown[]) => {
      if (typeof a[0] === 'string') selects.push(a[0]);
      return os(...a);
    };
    return q;
  };
  return selects;
};

describe('fetchPaymentDetail audiences', () => {
  it('contractor NEVER selects fx_rate, and fxRate is null even on an unprojected row', async () => {
    const { client } = fakeSupabase(seed());
    const selects = withSelectSpy(client);
    const pay = await fetchPaymentDetail(client, PAYMENT, { audience: 'contractor' });
    // Query level: the column is not on the wire at all…
    expect(selects.join('|')).not.toContain('fx_rate');
    // …and the mapper strips regardless (the fake returns whole rows, so this
    // leg only passes because of the audience check, not the projection).
    expect(pay?.fxRate).toBeNull();
  });

  it('admin selects and returns fx_rate', async () => {
    const { client } = fakeSupabase(seed());
    const selects = withSelectSpy(client);
    const pay = await fetchPaymentDetail(client, PAYMENT, { audience: 'admin' });
    expect(selects.some((s) => s.includes('fx_rate'))).toBe(true);
    expect(pay?.fxRate).toBe(56.2);
  });

  it('admin pay slip and portal statement assemble the SAME receipt input', async () => {
    const { client } = fakeSupabase(seed());
    const detail = await fetchPaymentDetail(client, PAYMENT, { audience: 'admin' });
    const own = await fetchOwnPayments(client, WORKER);
    expect(detail?.receipt).toBeTruthy();
    expect(detail?.receipt).toEqual(own[0]?.receipt);
    // The one rule worth pinning: deductions arrive already negative.
    expect(detail?.receipt.misc).toEqual([{ label: 'Laptop', amount: -500 }]);
  });
});
