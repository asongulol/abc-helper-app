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

  it('scopes to drafts by default: sent rows outside the bounce window are not re-checked', async () => {
    const { client } = fakeSupabase({
      payments: [{ ...payment('p1', '301'), status: 'sent', paid_at: '2026-01-01T00:00:00.000Z' }],
    });
    const res = await servicePoll(client, {}, fakeWise());
    expect(res.checked).toBe(0);
  });

  // #90 B: `paid_at` means SENT. A transfer can come back days later, and until
  // this the poll surfaced the dead status but wrote nothing, so the portal sunset
  // read the row as landed and locked out a contractor who was never paid.
  it('records a bounce on a recently sent row as failed + unpaid, keeping the evidence', async () => {
    const sentAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const { client, tables } = fakeSupabase({
      payments: [
        {
          ...payment('p-bounced', '401'),
          status: 'sent',
          paid_at: sentAt,
          note: 'Historical import',
        },
        { ...payment('p-fine', '402'), status: 'sent', paid_at: sentAt, wise_locked_at: 'lock-1' },
        { ...payment('p-old', '403'), status: 'sent', paid_at: '2026-01-01T00:00:00.000Z' },
        payment('p-draft-dead', '404'),
      ],
    });
    const api = fakeWise({
      transfers: [
        wiseDetail({ id: 401, status: 'bounced_back' }),
        wiseDetail({ id: 402, status: 'outgoing_payment_sent' }),
        wiseDetail({ id: 403, status: 'funds_refunded' }),
        wiseDetail({ id: 404, status: 'cancelled' }),
      ],
    });

    const res = await servicePoll(client, {}, api);

    // p-old is outside the window and never fetched; the other three are checked.
    expect(res.checked).toBe(3);
    expect(res.failed).toBe(1);
    expect(res.markedPaid).toBe(0); // a still-sent row is not "marked paid" again

    const bounced = tables.payments?.find((p) => p.id === 'p-bounced');
    expect(bounced?.status).toBe('failed');
    expect(bounced?.paid_at).toBeNull();
    expect(bounced?.wise_transfer_id).toBe('401');
    expect(bounced?.note).toBe(
      `Historical import\nWise transfer 401 is bounced_back (poll ${new Date().toISOString().slice(0, 10)}) — the money did not land. Unlink and re-send.`,
    );
    expect(res.results.find((r) => r.paymentId === 'p-bounced')?.failed).toBe(true);

    // Still sent: untouched, lock timestamp included.
    const fine = tables.payments?.find((p) => p.id === 'p-fine');
    expect(fine?.status).toBe('sent');
    expect(fine?.paid_at).toBe(sentAt);
    expect(fine?.wise_locked_at).toBe('lock-1');

    // A dead transfer on a row that never claimed payment is the normal unfunded
    // draft — surfaced, not written (and not counted as failed).
    const draftDead = tables.payments?.find((p) => p.id === 'p-draft-dead');
    expect(draftDead?.status).toBe('draft');
    expect(res.results.find((r) => r.paymentId === 'p-draft-dead')?.failed).toBeUndefined();
  });
});
