/**
 * In-memory WiseApi for service-layer tests (the WiseApi seam).
 *
 * Seeded with detail-shaped transfers; list rows are derived from them, the
 * way the real list endpoint is a projection of the same data. Mutate calls
 * are recorded on `.calls` for assertions, and like the real adapter the fake
 * has no funding method (ADR-0007 holds in tests too).
 */

import { toIsoWise } from '@/lib/wise/dates';
import type { WiseTransfer } from '@/lib/wise/types';
import type { WiseApi, WiseContact, WiseRecipient, WiseTransferDetail } from '@/server/wise/api';

export interface FakeWiseSeed {
  profileId?: number;
  transfers?: WiseTransferDetail[];
  recipients?: WiseRecipient[];
  contacts?: WiseContact[];
}

/** A full transfer detail with quiet defaults — override what the test asserts on. */
export const wiseDetail = (
  over: Partial<WiseTransferDetail> & { id: number | string },
): WiseTransferDetail => ({
  status: 'outgoing_payment_sent',
  rate: 1,
  sourceCurrency: 'PHP',
  targetCurrency: 'PHP',
  sourceValue: null,
  targetValue: 0,
  targetAccount: null,
  reference: null,
  created: '2026-07-16T00:00:00Z',
  dates: { created: '2026-07-16T00:00:00.000Z', dateFunded: null, dateSent: null },
  ...over,
});

const toListRow = (t: WiseTransferDetail): WiseTransfer => ({
  id: Number(t.id),
  status: t.status ?? '',
  targetAccount: t.targetAccount,
  targetValue: t.targetValue,
  created: t.created,
});

/** Every mutate call the fake saw, for "nothing was drafted" assertions. */
export interface FakeWiseCalls {
  quotes: { profileId: number; targetAmountPhp: number }[];
  transfers: { recipientId: number; quoteId: string; batchGroupId?: string }[];
  batchGroups: { profileId: number; name: string }[];
  cancels: string[];
}

export const fakeWise = (seed: FakeWiseSeed = {}): WiseApi & { calls: FakeWiseCalls } => {
  const transfers = seed.transfers ?? [];
  const recipients = seed.recipients ?? [];
  const calls: FakeWiseCalls = { quotes: [], transfers: [], batchGroups: [], cancels: [] };
  let nextId = 9000;
  return {
    calls,
    async getBusinessProfileId() {
      return seed.profileId ?? 1;
    },
    async getTransfer(id) {
      return transfers.find((t) => String(t.id) === String(id)) ?? null;
    },
    async listTransfers({ fromIso, toIso }) {
      return transfers
        .filter((t) => {
          const created = toIsoWise(t.created);
          return created != null && created >= fromIso && created <= toIso;
        })
        .map(toListRow);
    },
    async listRecipients() {
      return recipients;
    },
    async getRecipient(recipientId) {
      return recipients.find((r) => r.id === recipientId) ?? null;
    },
    async listContacts() {
      return seed.contacts ?? [];
    },
    async createQuote(profileId, targetAmountPhp) {
      calls.quotes.push({ profileId, targetAmountPhp });
      return { id: `q-${calls.quotes.length}`, rate: 1 };
    },
    async createTransfer(recipientId, quoteId, batch) {
      calls.transfers.push({
        recipientId,
        quoteId,
        ...(batch ? { batchGroupId: batch.batchGroupId } : {}),
      });
      return { id: ++nextId };
    },
    async createBatchGroup(profileId, name) {
      calls.batchGroups.push({ profileId, name });
      return { id: `bg-${calls.batchGroups.length}` };
    },
    async cancelTransfer(id) {
      calls.cancels.push(String(id));
      const t = transfers.find((x) => String(x.id) === String(id));
      if (t) t.status = 'cancelled';
      return { status: 'cancelled' };
    },
  };
};
