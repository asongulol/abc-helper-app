/**
 * In-memory WiseApi for service-layer tests (the WiseApi seam).
 *
 * Seeded with detail-shaped transfers; list rows are derived from them, the
 * way the real list endpoint is a projection of the same data. Read-only —
 * exactly the seam's surface, and like the real adapter it has no funding
 * method (ADR-0007 holds in tests too).
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

export const fakeWise = (seed: FakeWiseSeed = {}): WiseApi => {
  const transfers = seed.transfers ?? [];
  const recipients = seed.recipients ?? [];
  return {
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
  };
};
