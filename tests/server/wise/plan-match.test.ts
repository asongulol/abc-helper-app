/**
 * planMatchRun — the pure core of a match run, exercised with fakes only.
 * No Supabase, no env: the plan takes payments + pulled transfers and the
 * WiseApi seam, and returns decisions + the unlinked list.
 */

import { describe, expect, it } from 'vitest';
import type { MatchPayment } from '@/db/queries/wise';
import { type MatchRunInput, planMatchRun } from '@/server/wise/plan-match';
import { fakeWise, wiseDetail } from '../../fixtures/wise-fake';

// Semi-monthly arrears period: days 1–15 paid by month end (pay_date is the deadline).
const period = {
  pay_date: '2026-07-31',
  period_start: '2026-07-01',
  period_end: '2026-07-15',
  state: 'closed',
} as MatchPayment['pay_periods'];

const payment = (id: string, over: Partial<MatchPayment> = {}): MatchPayment => ({
  id,
  worker_id: `w-${id}`,
  pay_period_id: 'pp1',
  wise_transfer_id: null,
  status: 'draft',
  net_php: 10_000,
  original_net_php: null,
  payout_method: 'wise',
  paid_at: null,
  workers: {
    wise_recipient_id: 555,
    wise_recipient_uuid: null,
    wise_recipients: null,
    first_name: 'Ana',
    middle_name: null,
    last_name: 'Cruz',
  },
  pay_periods: period,
  ...over,
});

const runPlan = async (
  payments: MatchPayment[],
  api: ReturnType<typeof fakeWise>,
  over: Partial<MatchRunInput> = {},
) =>
  planMatchRun(
    {
      payments,
      transfers: await api.listTransfers({
        fromIso: '2026-01-01T00:00:00.000Z',
        toIso: '2027-01-01T00:00:00.000Z',
      }),
      claimed: new Set<string>(),
      profileId: 1,
      windowDays: 7,
      refresh: false,
      dryRun: false,
      nowIso: '2026-08-05T00:00:00.000Z',
      ...over,
    },
    api,
  );

describe('planMatchRun — taken set', () => {
  it('one transfer pays one row: a second same-recipient row cannot take it', async () => {
    const api = fakeWise({
      transfers: [
        wiseDetail({
          id: 101,
          targetAccount: 555,
          targetValue: 10_000,
          created: '2026-07-20T10:00:00Z',
        }),
      ],
    });
    const plan = await runPlan([payment('p1'), payment('p2')], api);

    const [d1, d2] = plan.decisions;
    expect(d1?.result.outcome).toBe('matched_exact');
    expect(d1?.patch?.wise_transfer_id).toBe('101');
    expect(d2?.result.outcome).toBe('no_wise_transfer');
    expect(d2?.patch).toBeUndefined();

    // The losing row is unlinked, and the taken transfer is NOT offered to it.
    expect(plan.unlinked.map((u) => u.paymentId)).toEqual(['p2']);
    expect(plan.unlinked[0]?.candidates).toEqual([]);
  });
});

describe('planMatchRun — ambiguity breaker', () => {
  const tiedPair = (refs: [string | null, string | null]) => [
    // Equidistant from the 07-31 deadline, both inside the legal window: a true tie.
    wiseDetail({
      id: 201,
      targetAccount: 555,
      targetValue: 10_000,
      created: '2026-07-30T00:00:00Z',
      reference: refs[0],
    }),
    wiseDetail({
      id: 202,
      targetAccount: 555,
      targetValue: 10_000,
      created: '2026-08-01T00:00:00Z',
      reference: refs[1],
    }),
  ];

  it('the reference that names this period resolves a true tie', async () => {
    const api = fakeWise({ transfers: tiedPair(['Payroll 2026-07-15', 'Payroll 2026-06-30']) });
    const plan = await runPlan([payment('p1')], api);
    expect(plan.decisions[0]?.result.outcome).toBe('matched_exact');
    expect(plan.decisions[0]?.patch?.wise_transfer_id).toBe('201');
  });

  it('without references the tie stays ambiguous, with both candidates listed', async () => {
    const api = fakeWise({ transfers: tiedPair([null, null]) });
    const plan = await runPlan([payment('p1')], api);
    const r = plan.decisions[0]?.result;
    expect(r?.outcome).toBe('ambiguous_exact');
    expect(plan.unlinked).toHaveLength(1);
    expect(plan.unlinked[0]?.candidates.map((c) => c.transfer_id).sort()).toEqual(['201', '202']);
  });
});

describe('planMatchRun — duplicate-reference guard', () => {
  it('refuses the only candidate when its reference names a different period', async () => {
    const api = fakeWise({
      transfers: [
        wiseDetail({
          id: 301,
          targetAccount: 555,
          targetValue: 10_000,
          created: '2026-07-20T10:00:00Z',
          reference: 'Payroll 2026-06-30',
        }),
      ],
    });
    const plan = await runPlan([payment('p1')], api);
    const d = plan.decisions[0];
    expect(d?.result.outcome).toBe('reference_names_other_period');
    expect(d?.patch).toBeUndefined();
    expect(plan.unlinked[0]?.reason).toContain('not this period');
  });
});

describe('planMatchRun — dry-run proposals', () => {
  it('a dry run leaves the row unlinked, carrying the proposed transfer as its candidate', async () => {
    const api = fakeWise({
      transfers: [
        wiseDetail({
          id: 401,
          targetAccount: 555,
          targetValue: 10_000,
          created: '2026-07-20T10:00:00Z',
        }),
      ],
    });

    const dry = await runPlan([payment('p1')], api, { dryRun: true });
    expect(dry.decisions[0]?.patch?.wise_transfer_id).toBe('401');
    expect(dry.unlinked).toHaveLength(1);
    expect(dry.unlinked[0]?.candidates.map((c) => c.transfer_id)).toEqual(['401']);

    // A real run links it, so the row leaves the unlinked list.
    const real = await runPlan([payment('p1')], api);
    expect(real.unlinked).toEqual([]);
  });

  it('a dry run keeps a dead link visible instead of silently adopting the relink', async () => {
    const api = fakeWise({
      transfers: [
        wiseDetail({
          id: 501,
          targetAccount: 555,
          targetValue: 10_000,
          status: 'cancelled',
          created: '2026-07-18T00:00:00Z',
        }),
        wiseDetail({
          id: 502,
          targetAccount: 555,
          targetValue: 10_000,
          created: '2026-07-20T00:00:00Z',
        }),
      ],
    });
    const ghostLinked = payment('p1', { wise_transfer_id: '501', status: 'sent' });

    const dry = await runPlan([ghostLinked], api, {
      refresh: true,
      dryRun: true,
      claimed: new Set(['501']),
    });
    expect(dry.decisions[0]?.result.outcome).toBe('refresh_transfer_dead');
    expect(dry.unlinked[0]?.reason).toContain('never paid');
    // The orphan sweep offers the transfer that actually paid.
    expect(dry.unlinked[0]?.candidates.map((c) => c.transfer_id)).toContain('502');

    // The write run relinks it in place.
    const write = await runPlan([ghostLinked], api, { refresh: true, claimed: new Set(['501']) });
    expect(write.decisions[0]?.result.outcome).toBe('matched_exact');
    expect(write.decisions[0]?.patch?.wise_transfer_id).toBe('502');
  });
});
