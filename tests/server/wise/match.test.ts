/**
 * serviceMatch — the IO shell around planMatchRun: one refresh run is a
 * superset of a plain match (linked rows re-checked, unlinked rows discovered),
 * and a dry run decides everything but writes nothing. This is exactly the
 * single call wisePeriodMatches makes for the reconcile view.
 */

import { describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from '../../fixtures/supabase-fake';
import { fakeWise, wiseDetail } from '../../fixtures/wise-fake';

// service.ts → client.ts reads env at import; the fake api means no fetch runs.
vi.mock('@/server/env', () => ({ env: { WISE_API_TOKEN: 'test-token' } }));

const { serviceMatch } = await import('@/server/wise/service');

const seed = () => ({
  workers: [
    {
      id: 'w1',
      wise_recipient_id: 555,
      wise_recipient_uuid: null,
      wise_recipients: null,
      first_name: 'Ana',
      middle_name: null,
      last_name: 'Cruz',
    },
  ],
  pay_periods: [
    {
      id: 'pp1',
      pay_date: '2026-07-31',
      period_start: '2026-07-01',
      period_end: '2026-07-15',
      state: 'closed',
    },
  ],
  payments: [
    {
      id: 'p-linked',
      worker_id: 'w1',
      pay_period_id: 'pp1',
      wise_transfer_id: '601',
      status: 'sent',
      net_php: 10_000,
      original_net_php: null,
      payout_method: 'wise',
      paid_at: null,
    },
    {
      id: 'p-new',
      worker_id: 'w1',
      pay_period_id: 'pp1',
      wise_transfer_id: null,
      status: 'draft',
      net_php: 20_000,
      original_net_php: null,
      payout_method: 'wise',
      paid_at: null,
    },
  ],
});

const api = () =>
  fakeWise({
    transfers: [
      wiseDetail({
        id: 601,
        targetAccount: 555,
        targetValue: 10_000,
        created: '2026-07-18T00:00:00Z',
      }),
      wiseDetail({
        id: 602,
        targetAccount: 555,
        targetValue: 20_000,
        created: '2026-07-20T00:00:00Z',
      }),
    ],
  });

describe('serviceMatch — refresh is a superset of match', () => {
  it('one refresh run re-checks the linked row AND links the unmatched one', async () => {
    const { client, tables } = fakeSupabase(seed());

    const res = await serviceMatch(client, { refresh: true }, api());

    expect(res.mode).toBe('refresh');
    expect(res.scanned).toBe(2);
    expect(res.matched).toBe(2); // refreshed_clean + matched_exact
    expect(res.unlinked).toEqual([]);

    const linked = tables.payments?.find((p) => p.id === 'p-new');
    expect(linked?.wise_transfer_id).toBe('602');
    const refreshed = tables.payments?.find((p) => p.id === 'p-linked');
    expect(refreshed?.wise_dates).toBeTruthy();
  });

  it('a dry run decides both rows but writes nothing', async () => {
    const { client, tables } = fakeSupabase(seed());

    const res = await serviceMatch(client, { refresh: true, dryRun: true }, api());

    expect(res.scanned).toBe(2);
    // The proposal surfaces as an unlinked row carrying its candidate.
    expect(res.unlinked.map((u) => u.paymentId)).toEqual(['p-new']);
    expect(res.unlinked[0]?.candidates.map((c) => c.transfer_id)).toEqual(['602']);

    const untouched = tables.payments?.find((p) => p.id === 'p-new');
    expect(untouched?.wise_transfer_id).toBeNull();
    expect(tables.payments?.find((p) => p.id === 'p-linked')?.wise_dates).toBeUndefined();
  });
});
