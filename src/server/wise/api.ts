import 'server-only';
import { wiseDatesFromRow } from '@/lib/wise/dates';
import type { WiseDates, WiseTransfer } from '@/lib/wise/types';
import { wiseRequest, wiseRequestNullable } from './client';

/**
 * WiseApi — the seam between the payout service layer and Wise's HTTP API.
 *
 * Domain-typed on both sides: callers never see raw `Record<string, unknown>`
 * bodies, URL paths, or paging loops. `realWiseApi` is the HTTP adapter over
 * client.ts; tests inject the in-memory fake (tests/fixtures/wise-fake.ts).
 *
 * DRAFT-ONLY (ADR-0007): the mutate half stops at drafting (quote, transfer,
 * batch group) and cancelling. There is deliberately no funding method here
 * and never will be — the guardrail scanner enforces that repo-wide.
 */

/** GET /v1/transfers/{id}, every field the service layer reads, typed once. */
export interface WiseTransferDetail {
  id: number | string;
  status: string | null;
  rate: number | null;
  sourceCurrency: string | null;
  targetCurrency: string | null;
  sourceValue: number | null;
  targetValue: number | null;
  targetAccount: number | string | null;
  /** `details.reference` (falling back to a top-level `reference`), trimmed;
   *  null when absent or blank. The strongest period-matching signal. */
  reference: string | null;
  /** Raw created timestamp as Wise sent it (normalised copy in `dates`). */
  created: string | null;
  dates: WiseDates;
}

export interface WiseRecipient {
  id: number;
  name: string;
  currency: string;
  account: string;
  email: string | null;
  active: boolean;
}

/** A Wise-to-Wise / balance contact (GET /v1/profiles/{pid}/contacts). */
export interface WiseContact {
  /** Contact id — UUID-shaped for real balance contacts; this IS the manual
   *  Batch-CSV recipientId (== workers.wise_recipient_uuid). */
  uuid: string;
  /** `balanceRecipientId` — the numeric id (== workers.wise_recipient_id). */
  recipientId: number;
  name: string;
}

/** A quote for a draft transfer. `rate` falls back to 1 when Wise omits it. */
export interface WiseQuote {
  id: string;
  rate: number;
}

export interface WiseApi {
  /** The business profile id (memoized — constant for the account). */
  getBusinessProfileId(): Promise<number>;
  /** Full transfer detail; null when the transfer is absent. */
  getTransfer(id: string | number): Promise<WiseTransferDetail | null>;
  /** Transfer history for a created-date window, paging absorbed. */
  listTransfers(window: { fromIso: string; toIso: string }): Promise<WiseTransfer[]>;
  /** ACTIVE recipients only — a deleted recipient needs getRecipient(id). */
  listRecipients(profileId: number): Promise<WiseRecipient[]>;
  /** One recipient by id — still resolves recipients since deleted. */
  getRecipient(recipientId: number): Promise<WiseRecipient | null>;
  /** Balance/Wisetag contacts. Wise IGNORES searchTerm and returns the first
   *  page regardless — callers filter client-side. */
  listContacts(profileId: number, searchTerm?: string): Promise<WiseContact[]>;

  // Mutate half — drafting and cancelling ONLY. No funding method (ADR-0007).

  /** PHP→PHP BALANCE quote for a target amount. */
  createQuote(profileId: number, targetAmountPhp: number): Promise<WiseQuote>;
  /** Draft a transfer against an EXISTING recipient (no bank details), inside a
   *  batch group when `batch` is given. Money does NOT move — the draft sits
   *  unfunded until the owner funds it in the Wise UI. */
  createTransfer(
    recipientId: number,
    quoteId: string,
    batch?: { profileId: number; batchGroupId: string },
  ): Promise<{ id: number }>;
  /** An empty PHP batch group for createTransfer to draft into. */
  createBatchGroup(profileId: number, name: string): Promise<{ id: string }>;
  /** PUT cancel on an unfunded draft; returns the post-cancel status.
   *  Callers gate on isCancellable first — this is the raw call. */
  cancelTransfer(id: string | number): Promise<{ status: string }>;
}

// ─── HTTP adapter ─────────────────────────────────────────────────────────────

const mapDetail = (raw: Record<string, unknown>): WiseTransferDetail => {
  const details = raw.details as { reference?: unknown } | null | undefined;
  const ref = details?.reference ?? raw.reference;
  return {
    id: raw.id as number | string,
    status: (raw.status as string | null | undefined) ?? null,
    rate: (raw.rate as number | null | undefined) ?? null,
    sourceCurrency: (raw.sourceCurrency as string | null | undefined) ?? null,
    targetCurrency: (raw.targetCurrency as string | null | undefined) ?? null,
    sourceValue: (raw.sourceValue as number | null | undefined) ?? null,
    targetValue: (raw.targetValue as number | null | undefined) ?? null,
    targetAccount: (raw.targetAccount as number | string | null | undefined) ?? null,
    reference: typeof ref === 'string' && ref.trim() !== '' ? ref.trim() : null,
    created: (raw.created as string | null | undefined) ?? null,
    dates: wiseDatesFromRow(raw),
  };
};

/** One mapper for both recipient endpoints (list + by-id) so they can't drift. */
const mapRecipient = (a: Record<string, unknown>): WiseRecipient => {
  const d = (a.details as Record<string, unknown> | null | undefined) ?? {};
  const hint =
    (d.accountNumber as string | null | undefined) ??
    (d.iban as string | null | undefined) ??
    (d.email as string | null | undefined) ??
    '';
  return {
    id: a.id as number,
    name:
      (a.accountHolderName as string | null | undefined) ??
      (a.name as string | null | undefined) ??
      '',
    currency:
      (a.currency as string | null | undefined) ?? (d.currency as string | null | undefined) ?? '',
    account: hint ? `••••${String(hint).slice(-4)}` : '',
    email: (d.email as string | null | undefined) ?? null,
    active: (a.active as boolean | null | undefined) !== false,
  };
};

// The Wise business profile id is constant for the account. Memoize at module
// scope so warm Next.js instances skip the redundant GET /v2/profiles round-trip.
// Only the resolved value is cached; a thrown fetch never poisons the cache.
let cachedProfileId: number | null = null;

async function getBusinessProfileId(): Promise<number> {
  if (cachedProfileId != null) return cachedProfileId;
  const profiles = await wiseRequest<{ id: number; type: string }[]>('/v2/profiles');
  // Wise returns type as "BUSINESS"/"PERSONAL" (uppercase) — compare case-insensitively.
  const biz = profiles.find((p) => p.type?.toUpperCase() === 'BUSINESS') ?? profiles[0];
  if (!biz) throw new Error('No Wise business profile found on this account.');
  cachedProfileId = biz.id;
  return cachedProfileId;
}

export const realWiseApi: WiseApi = {
  getBusinessProfileId,

  async getTransfer(id) {
    const raw = await wiseRequestNullable<Record<string, unknown>>(`/v1/transfers/${id}`);
    return raw ? mapDetail(raw) : null;
  },

  async listTransfers({ fromIso, toIso }) {
    const profileId = await getBusinessProfileId();
    const all: WiseTransfer[] = [];
    let offset = 0;
    const pageSize = 100;
    // Safety: cap at 50 pages = 5,000 transfers (~2 years).
    for (let i = 0; i < 50; i++) {
      const qs = new URLSearchParams({
        profile: String(profileId),
        limit: String(pageSize),
        offset: String(offset),
        createdDateStart: fromIso,
        createdDateEnd: toIso,
      });
      const page = await wiseRequest<WiseTransfer[]>(`/v1/transfers?${qs.toString()}`);
      if (!Array.isArray(page) || page.length === 0) break;
      all.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }
    return all;
  },

  async listRecipients(profileId) {
    const accounts = await wiseRequest<Record<string, unknown>[]>(
      `/v1/accounts?profile=${profileId}`,
    );
    return (Array.isArray(accounts) ? accounts : []).map(mapRecipient);
  },

  async getRecipient(recipientId) {
    const a = await wiseRequestNullable<Record<string, unknown>>(`/v1/accounts/${recipientId}`);
    return a ? mapRecipient(a) : null;
  },

  async listContacts(profileId, searchTerm = '') {
    const raw = await wiseRequest<Record<string, unknown>[]>(
      `/v1/profiles/${profileId}/contacts?searchTerm=${encodeURIComponent(searchTerm)}`,
    );
    return (Array.isArray(raw) ? raw : []).map((c) => ({
      uuid: String((c.id as string | number | null | undefined) ?? ''),
      recipientId: Number(c.balanceRecipientId ?? 0),
      name:
        (c.name as string | null | undefined) ??
        (c.accountHolderName as string | null | undefined) ??
        '',
    }));
  },

  async createQuote(profileId, targetAmountPhp) {
    const q = await wiseRequest<{ id: string; rate?: number }>(`/v3/profiles/${profileId}/quotes`, {
      method: 'POST',
      body: {
        sourceCurrency: 'PHP',
        targetCurrency: 'PHP',
        targetAmount: targetAmountPhp,
        payOut: 'BALANCE',
      },
    });
    return { id: q.id, rate: q.rate ?? 1 };
  },

  async createTransfer(recipientId, quoteId, batch) {
    const path = batch
      ? `/v3/profiles/${batch.profileId}/batch-groups/${batch.batchGroupId}/transfers`
      : '/v1/transfers';
    return wiseRequest<{ id: number }>(path, {
      method: 'POST',
      body: {
        targetAccount: recipientId,
        quoteUuid: quoteId,
        customerTransactionId: crypto.randomUUID(),
        details: {
          reference: 'Payroll',
          transferPurpose: 'verification.transfers.purpose.pay.bills',
        },
      },
    });
  },

  async createBatchGroup(profileId, name) {
    return wiseRequest<{ id: string }>(`/v3/profiles/${profileId}/batch-groups`, {
      method: 'POST',
      body: { name, sourceCurrency: 'PHP' },
    });
  },

  async cancelTransfer(id) {
    const cancelled = await wiseRequest<Record<string, unknown>>(`/v1/transfers/${id}/cancel`, {
      method: 'PUT',
    });
    return { status: String(cancelled.status ?? 'cancelled') };
  },
};
