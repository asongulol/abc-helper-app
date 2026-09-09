import { describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from '../../fixtures/supabase-fake';
import { fakeWise, wiseDetail } from '../../fixtures/wise-fake';

// service.ts → client.ts reads env at import; the fake api means no fetch runs.
vi.mock('@/server/env', () => ({ env: { WISE_API_TOKEN: 'test-token' } }));

const { serviceBatch, serviceCancelTransfer, serviceDraft } = await import('@/server/wise/service');

const worker = { id: 'w1', wise_recipient_id: 77, first_name: 'Ana', last_name: 'Cruz' };

const payment = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  worker_id: 'w1',
  net_php: 1000,
  wise_transfer_id: null,
  status: 'unpaid',
  paid_at: null,
  ...over,
});

describe('serviceDraft — RP-09 double-draft guard through the fake', () => {
  it('drafts only the clean row; linked and paid rows record NO createTransfer', async () => {
    const { client, tables } = fakeSupabase({
      workers: [worker],
      payments: [
        payment('p-linked', { wise_transfer_id: '555' }),
        payment('p-paid', { paid_at: '2026-07-18T00:00:00Z', status: 'sent' }),
        payment('p-ok'),
      ],
    });
    const api = fakeWise();

    const { results } = await serviceDraft(client, ['p-linked', 'p-paid', 'p-ok'], api);

    const byId = new Map(results.map((r) => [r.paymentId, r]));
    expect(byId.get('p-linked')).toMatchObject({ status: 'skipped', error: 'already drafted' });
    expect(byId.get('p-paid')).toMatchObject({ status: 'skipped', error: 'already paid' });
    expect(byId.get('p-ok')?.status).toBe('drafted');

    // The RP-09 core: exactly one transfer drafted, for the clean row's recipient.
    expect(api.calls.transfers).toEqual([{ recipientId: 77, quoteId: 'q-1' }]);

    // Write-back: only the clean row gained an id; the linked row keeps its own.
    expect(tables.payments?.find((p) => p.id === 'p-ok')?.wise_transfer_id).toBe('9001');
    expect(tables.payments?.find((p) => p.id === 'p-linked')?.wise_transfer_id).toBe('555');
    expect(tables.payments?.find((p) => p.id === 'p-paid')?.wise_transfer_id).toBeNull();
  });
});

describe('serviceBatch — drafts inside the batch group, same guard', () => {
  it('creates one group and drafts eligible rows into it', async () => {
    const { client, tables } = fakeSupabase({
      workers: [worker],
      payments: [payment('p-linked', { wise_transfer_id: '555' }), payment('p-ok')],
    });
    const api = fakeWise();

    const res = await serviceBatch(
      client,
      [{ paymentId: 'p-linked' }, { paymentId: 'p-ok' }],
      'July 2nd half',
      api,
    );

    expect(res.batchGroupId).toBe('bg-1');
    expect(api.calls.batchGroups).toEqual([{ profileId: 1, name: 'July 2nd half' }]);
    expect(api.calls.transfers).toEqual([
      { recipientId: 77, quoteId: 'q-1', batchGroupId: 'bg-1' },
    ]);
    expect(tables.payments?.find((p) => p.id === 'p-ok')?.wise_transfer_id).toBe('9001');
  });

  it('throws before creating a group when nothing is eligible', async () => {
    const { client } = fakeSupabase({
      workers: [worker],
      payments: [payment('p-linked', { wise_transfer_id: '555' })],
    });
    const api = fakeWise();

    await expect(serviceBatch(client, [{ paymentId: 'p-linked' }], undefined, api)).rejects.toThrow(
      /No eligible payments/,
    );
    expect(api.calls.batchGroups).toEqual([]);
    expect(api.calls.transfers).toEqual([]);
  });
});

describe('serviceCancelTransfer — refusal ladder on the seam', () => {
  it('cancels an unfunded draft and notes the row', async () => {
    const { client, tables } = fakeSupabase({
      payments: [payment('p1', { wise_transfer_id: '101', note: null })],
    });
    const api = fakeWise({
      transfers: [wiseDetail({ id: 101, status: 'incoming_payment_waiting' })],
    });

    const res = await serviceCancelTransfer(
      client,
      { id: 'p1', wise_transfer_id: '101', note: null },
      'duplicate batch',
      api,
    );

    expect(res).toEqual({
      transferId: '101',
      previousStatus: 'incoming_payment_waiting',
      status: 'cancelled',
    });
    expect(api.calls.cancels).toEqual(['101']);
    expect(tables.payments?.find((p) => p.id === 'p1')?.note).toContain(
      'Cancelled draft #101: duplicate batch',
    );
  });

  it('refuses a transfer that already paid, and one it cannot find', async () => {
    const { client } = fakeSupabase({ payments: [] });
    const api = fakeWise({
      transfers: [wiseDetail({ id: 101, status: 'outgoing_payment_sent' })],
    });

    await expect(
      serviceCancelTransfer(client, { id: 'p1', wise_transfer_id: '101', note: null }, 'x', api),
    ).rejects.toThrow(/already gone out/);
    await expect(
      serviceCancelTransfer(client, { id: 'p1', wise_transfer_id: '999', note: null }, 'x', api),
    ).rejects.toThrow(/not found on this account/);
    expect(api.calls.cancels).toEqual([]);
  });
});

describe('failover — the next saved recipient when Wise rejects the default', () => {
  const twoRecipients = {
    ...worker,
    wise_recipient_id: 77,
    wise_recipients: [
      { id: 77, uuid: 'tag-uuid', label: 'Wisetag' },
      { id: 88, uuid: 'bank-uuid', label: 'Bank' },
    ],
  };
  /** A fake whose transfer endpoint 422s for the given recipient ids. */
  const rejecting = (ids: number[], status = 422) => {
    const api = fakeWise();
    const real = api.createTransfer;
    // The fake only records successful drafts; `attempts` sees every try.
    const attempts: { recipientId: number; batchGroupId?: string }[] = [];
    api.createTransfer = async (recipientId, quoteId, batch) => {
      attempts.push({ recipientId, ...(batch ? { batchGroupId: batch.batchGroupId } : {}) });
      if (ids.includes(recipientId)) {
        throw new Error(
          `Wise API POST /v1/transfers → ${status}: {"errors":[{"code":"targetAccount.invalid","message":"recipient not supported"}]}`,
        );
      }
      return real(recipientId, quoteId, batch);
    };
    return Object.assign(api, { attempts });
  };

  it('drafts at the failover and says so when the default is a rejected Wisetag', async () => {
    const { client, tables } = fakeSupabase({
      workers: [twoRecipients],
      payments: [payment('p1')],
    });
    const api = rejecting([77]);

    const { results } = await serviceDraft(client, ['p1'], api);

    expect(results[0]).toMatchObject({ status: 'drafted', recipientId: 88, failover: true });
    expect(api.attempts.map((t) => t.recipientId)).toEqual([77, 88]);
    expect(api.calls.quotes).toHaveLength(1); // one quote serves both attempts
    expect(tables.payments?.[0]?.wise_transfer_id).toBe('9001');
  });

  it('fails (and drafts nothing) when every recipient is rejected', async () => {
    const { client, tables } = fakeSupabase({
      workers: [twoRecipients],
      payments: [payment('p1')],
    });
    const api = rejecting([77, 88]);

    const { results } = await serviceDraft(client, ['p1'], api);

    expect(results[0]).toMatchObject({ status: 'failed', error: 'wisetag_unsupported' });
    expect(tables.payments?.[0]?.wise_transfer_id).toBeNull();
  });

  it('does NOT fail over on a non-recipient error — a network blip is not a wrong account', async () => {
    const { client } = fakeSupabase({ workers: [twoRecipients], payments: [payment('p1')] });
    const api = fakeWise();
    api.createTransfer = async () => {
      throw new Error('Wise API POST /v1/transfers → 500: upstream timeout');
    };

    const { results } = await serviceDraft(client, ['p1'], api);

    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toContain('500');
  });

  it('inside a batch group: the override is tried first, the default is its failover', async () => {
    const { client } = fakeSupabase({ workers: [twoRecipients], payments: [payment('p1')] });
    const api = rejecting([88]);

    const res = await serviceBatch(client, [{ paymentId: 'p1', recipientId: 88 }], 'x', api);

    expect(res.results[0]).toMatchObject({ status: 'drafted', recipientId: 77, failover: true });
    expect(api.attempts.map((t) => [t.recipientId, t.batchGroupId])).toEqual([
      [88, 'bg-1'],
      [77, 'bg-1'],
    ]);
  });
});
