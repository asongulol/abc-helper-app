import { describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from '../../fixtures/supabase-fake';
import { fakeWise, wiseDetail } from '../../fixtures/wise-fake';

// service.ts → client.ts reads env at import; the fake api means no fetch runs.
vi.mock('@/server/env', () => ({ env: { WISE_API_TOKEN: 'test-token' } }));

const { serviceLinkTransfer, serviceUnlinkTransfer } = await import('@/server/wise/service');

const WINDOW = { periodStart: '2026-07-01', payDate: '2026-07-15' };

const seedPayment = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  worker_id: 'w1',
  wise_transfer_id: null,
  status: 'draft',
  note: null,
  ...over,
});

describe('serviceLinkTransfer — refusals', () => {
  it('refuses a transfer another payment already holds', async () => {
    const { client } = fakeSupabase({
      payments: [
        seedPayment(),
        seedPayment({ id: 'p2', worker_id: 'w2', wise_transfer_id: '500' }),
      ],
      workers: [{ id: 'w2', first_name: 'Maria', last_name: 'Cruz' }],
    });
    await expect(serviceLinkTransfer(client, 'p1', '500', 1000, {}, fakeWise())).rejects.toThrow(
      /already linked to Maria Cruz/,
    );
  });

  it('refuses a transfer that does not exist on the account', async () => {
    const { client } = fakeSupabase({ payments: [seedPayment()] });
    await expect(serviceLinkTransfer(client, 'p1', '404', 1000, {}, fakeWise())).rejects.toThrow(
      /not found/,
    );
  });

  it('refuses a cancelled transfer — it never paid anyone', async () => {
    const { client } = fakeSupabase({ payments: [seedPayment()] });
    const api = fakeWise({ transfers: [wiseDetail({ id: 500, status: 'cancelled' })] });
    await expect(serviceLinkTransfer(client, 'p1', '500', 1000, {}, api)).rejects.toThrow(
      /cancelled — it never paid anyone/,
    );
  });

  it("refuses an in-flight draft — it hasn't paid yet", async () => {
    const { client } = fakeSupabase({ payments: [seedPayment()] });
    const api = fakeWise({ transfers: [wiseDetail({ id: 500, status: 'processing' })] });
    await expect(serviceLinkTransfer(client, 'p1', '500', 1000, {}, api)).rejects.toThrow(
      /hasn't paid anyone yet/,
    );
  });

  it('refuses an out-of-window link without a reason, accepts it with one', async () => {
    const sent = {
      created: '2026-08-30T00:00:00.000Z',
      dateFunded: null,
      dateSent: '2026-09-01T00:00:00.000Z', // past payDate + 14d
    };
    const api = fakeWise({
      transfers: [wiseDetail({ id: 500, targetValue: 1200, dates: sent })],
    });

    const a = fakeSupabase({ payments: [seedPayment()] });
    await expect(
      serviceLinkTransfer(a.client, 'p1', '500', 1000, { window: WINDOW }, api),
    ).rejects.toThrow(/outside this period's payment window/);
    expect(a.tables.payments?.[0]?.wise_transfer_id).toBeNull();

    const b = fakeSupabase({ payments: [seedPayment()] });
    const res = await serviceLinkTransfer(
      b.client,
      'p1',
      '500',
      1000,
      { window: WINDOW, reason: 'paid early with the August batch' },
      api,
    );
    expect(res.outOfWindow).toBe(true);
    expect(res.delta).toBe(200); // wise 1200 − db 1000; net_php itself is never rewritten
    const row = b.tables.payments?.[0];
    expect(row?.wise_transfer_id).toBe('500');
    expect(row?.status).toBe('sent');
    expect(row?.paid_at).toBe('2026-09-01T00:00:00.000Z');
    expect(row?.net_php).toBeUndefined();
    expect(row?.note).toMatch(/Linked #500: paid early/);
  });

  it('links a paid in-window transfer without demanding a reason', async () => {
    const api = fakeWise({
      transfers: [
        wiseDetail({
          id: 500,
          targetValue: 1000,
          dates: {
            created: '2026-07-16T00:00:00.000Z',
            dateFunded: null,
            dateSent: '2026-07-18T00:00:00.000Z',
          },
        }),
      ],
    });
    const { client, tables } = fakeSupabase({ payments: [seedPayment()] });
    const res = await serviceLinkTransfer(client, 'p1', '500', 1000, { window: WINDOW }, api);
    expect(res.outOfWindow).toBe(false);
    expect(tables.payments?.[0]?.wise_transfer_id).toBe('500');
  });
});

describe('serviceUnlinkTransfer — refusals', () => {
  it('refuses while the linked transfer is a live unfunded draft (RP-09 route)', async () => {
    const { client } = fakeSupabase({ payments: [seedPayment({ wise_transfer_id: '500' })] });
    const api = fakeWise({ transfers: [wiseDetail({ id: 500, status: 'processing' })] });
    await expect(
      serviceUnlinkTransfer(
        client,
        { id: 'p1', wise_transfer_id: '500', status: 'sent', note: null },
        'wrong row',
        api,
      ),
    ).rejects.toThrow(/Cancel it first/);
  });

  it('unlinks when the transfer is unreadable, clearing the link and keeping provenance', async () => {
    const { client, tables } = fakeSupabase({
      payments: [
        seedPayment({
          wise_transfer_id: '500',
          status: 'reconciled',
          paid_at: '2026-07-18T00:00:00.000Z',
          note: 'Historical import',
        }),
      ],
    });
    const res = await serviceUnlinkTransfer(
      client,
      { id: 'p1', wise_transfer_id: '500', status: 'reconciled', note: 'Historical import' },
      'ghost link',
      fakeWise(), // transfer absent in Wise
    );
    expect(res.wiseStatus).toBeNull();
    const row = tables.payments?.[0];
    expect(row?.wise_transfer_id).toBeNull();
    expect(row?.paid_at).toBeNull();
    expect(row?.status).toBe('sent'); // 'reconciled' is a claim about a transfer it no longer holds
    expect(row?.note).toBe('Historical import\nUnlinked #500: ghost link');
  });
});
