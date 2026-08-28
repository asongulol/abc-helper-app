import { describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from '../../fixtures/supabase-fake';
import { fakeWise, wiseDetail } from '../../fixtures/wise-fake';

// service.ts → client.ts reads env at import; the fake api means no fetch runs.
vi.mock('@/server/env', () => ({ env: { WISE_API_TOKEN: 'test-token' } }));

const { servicePoll } = await import('@/server/wise/service');

const payment = (id: string, transferId: string) => ({
  id,
  worker_id: `w-${id}`,
  pay_period_id: 'pp1',
  wise_transfer_id: transferId,
  status: 'draft',
  net_php: 1000,
});

describe('servicePoll — tri-classification of Wise statuses', () => {
  it('classifies paid / in-flight / unknown, and only the paid row is written', async () => {
    const { client, tables } = fakeSupabase({
      payments: [
        payment('p-paid', '101'),
        payment('p-flight', '102'),
        payment('p-dead', '103'),
        payment('p-gone', '999'), // no such transfer in Wise
      ],
    });
    const api = fakeWise({
      transfers: [
        wiseDetail({
          id: 101,
          status: 'outgoing_payment_sent',
          dates: {
            created: '2026-07-16T00:00:00.000Z',
            dateFunded: '2026-07-17T00:00:00.000Z',
            dateSent: '2026-07-18T03:00:00.000Z',
          },
        }),
        wiseDetail({ id: 102, status: 'processing' }),
        wiseDetail({ id: 103, status: 'cancelled' }),
      ],
    });

    const res = await servicePoll(client, {}, api);

    expect(res.checked).toBe(4);
    expect(res.markedPaid).toBe(1);
    expect(res.inFlight).toBe(1);
    expect(res.unknown).toBe(1);

    // Paid: marked sent at Wise's REAL dateSent (not now()), dates + lock stored.
    const paid = tables.payments?.find((p) => p.id === 'p-paid');
    expect(paid?.status).toBe('sent');
    expect(paid?.paid_at).toBe('2026-07-18T03:00:00.000Z');
    expect(paid?.wise_locked_at).toBeTruthy();
    expect(paid?.wise_dates).toEqual({
      created: '2026-07-16T00:00:00.000Z',
      dateFunded: '2026-07-17T00:00:00.000Z',
      dateSent: '2026-07-18T03:00:00.000Z',
    });

    // In-flight and dead rows are surfaced but the DB is untouched.
    for (const id of ['p-flight', 'p-dead', 'p-gone']) {
      const row = tables.payments?.find((p) => p.id === id);
      expect(row?.status).toBe('draft');
      expect(row?.paid_at).toBeUndefined();
    }

    // The dead (cancelled) transfer is reported with its status, unclassified —
    // not paid, not in-flight, not unknown.
    const dead = res.results.find((r) => r.paymentId === 'p-dead');
    expect(dead?.status).toBe('cancelled');
    expect(dead?.markedPaid).toBeUndefined();
    expect(dead?.inFlight).toBeUndefined();

    const gone = res.results.find((r) => r.paymentId === 'p-gone');
    expect(gone?.status).toBe('unknown');
  });

  it('falls back to dateFunded then created when dateSent is missing', async () => {
    const { client, tables } = fakeSupabase({ payments: [payment('p1', '201')] });
    const api = fakeWise({
      transfers: [
        wiseDetail({
          id: 201,
          status: 'completed',
          dates: {
            created: '2026-07-16T00:00:00.000Z',
            dateFunded: '2026-07-17T00:00:00.000Z',
            dateSent: null,
          },
        }),
      ],
    });

    const res = await servicePoll(client, {}, api);
    expect(res.markedPaid).toBe(1);
    expect(tables.payments?.[0]?.paid_at).toBe('2026-07-17T00:00:00.000Z');
  });

  it('scopes to drafts by default: sent rows are not re-checked', async () => {
    const { client } = fakeSupabase({
      payments: [{ ...payment('p1', '301'), status: 'sent' }],
    });
    const res = await servicePoll(client, {}, fakeWise());
    expect(res.checked).toBe(0);
  });
});
