import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyMatchPatch,
  fetchDraftPayments,
  fetchMatchPayments,
  fetchPollPayments,
  markPaymentSent,
} from '@/db/queries/wise';
import type { Database } from '@/db/types';
import { bestSentDate, wiseDatesFromListRow, wiseDatesFromRow } from '@/lib/wise/dates';
import { resolveDraftRow } from '@/lib/wise/draft-row';
import {
  annotateOrphans,
  buildRecipientIndex,
  buildTransferIdIndex,
  decideMatch,
  decideRefresh,
  filterLive,
} from '@/lib/wise/matcher';
import { missingRecipientReason } from '@/lib/wise/recipient-miss';
import type { MatchDecision, MatchResult, WiseDates, WiseTransfer } from '@/lib/wise/types';
import { WISE_IN_FLIGHT_STATES, WISE_PAID_STATES } from '@/lib/wise/types';
import type { WiseBatchItem } from '@/types/schemas/wise';
import { wiseRequest, wiseRequestNullable } from './client';

type Db = SupabaseClient<Database>;

const DAY_MS = 86_400_000;

// ─── profile id cache ─────────────────────────────────────────────────────────

// The Wise business profile id is constant for the account. Memoize at module
// scope so warm Next.js instances skip the redundant GET /v2/profiles round-trip.
// Only the resolved value is cached; a thrown fetch never poisons the cache.
let cachedProfileId: number | null = null;

export async function getBusinessProfileId(): Promise<number> {
  if (cachedProfileId != null) return cachedProfileId;
  const profiles = await wiseRequest<{ id: number; type: string }[]>('/v2/profiles');
  const biz = profiles.find((p) => p.type === 'business') ?? profiles[0];
  if (!biz) throw new Error('No Wise business profile found on this account.');
  cachedProfileId = biz.id;
  return cachedProfileId;
}

// ─── concurrency helper ────────────────────────────────────────────────────────

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      // noUncheckedIndexedAccess: items[i] is safe because i < items.length.
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─── date helpers (server-side network) ───────────────────────────────────────

/**
 * Pull a single transfer's full detail to capture dateFunded / dateSent that
 * the LIST endpoint omits. Falls back to list-row created if the detail fetch
 * fails. Use only when you have a list row (not the full detail) — the poll
 * loop already has the detail and should use wiseDatesFromRow() directly.
 */
async function fetchWiseDates(listRow: WiseTransfer): Promise<WiseDates> {
  const dates = wiseDatesFromListRow(listRow);
  try {
    const detail = await wiseRequest<Record<string, unknown>>(`/v1/transfers/${listRow.id}`);
    const d = wiseDatesFromRow(detail);
    dates.dateFunded = d.dateFunded;
    dates.dateSent = d.dateSent;
    if (!dates.created) dates.created = d.created;
  } catch {
    // best-effort — keep created at minimum
  }
  return dates;
}

// ─── draft ────────────────────────────────────────────────────────────────────

export interface DraftOneResult {
  paymentId: string;
  transferId?: number;
  fxRate?: number;
  status: 'drafted' | 'skipped' | 'failed';
  error?: string;
}

/**
 * Create a quote + draft transfer for a single payment. NEVER calls the funding
 * endpoint — the owner funds manually in the Wise UI (ADR-0007).
 */
async function draftOne(
  profileId: number,
  paymentId: string,
  recipientId: number,
  amountPhp: number,
): Promise<DraftOneResult> {
  // 1. Quote (PHP → PHP, BALANCE payout).
  let quote: { id: string; rate?: number };
  try {
    quote = await wiseRequest<{ id: string; rate?: number }>(`/v3/profiles/${profileId}/quotes`, {
      method: 'POST',
      body: {
        sourceCurrency: 'PHP',
        targetCurrency: 'PHP',
        targetAmount: amountPhp,
        payOut: 'BALANCE',
      },
    });
  } catch (e) {
    return { paymentId, status: 'failed', error: `quote: ${String(e)}` };
  }

  // 2. Transfer (references an EXISTING recipient by id; no bank details here).
  let transfer: { id: number };
  try {
    transfer = await wiseRequest<{ id: number }>('/v1/transfers', {
      method: 'POST',
      body: {
        targetAccount: recipientId,
        quoteUuid: quote.id,
        customerTransactionId: crypto.randomUUID(),
        details: {
          reference: 'Payroll',
          transferPurpose: 'verification.transfers.purpose.pay.bills',
        },
      },
    });
  } catch (e) {
    return { paymentId, status: 'failed', error: `transfer: ${String(e)}` };
  }

  // IMPORTANT: we stop here. No POST .../payments. Money has NOT moved.
  return {
    paymentId,
    transferId: transfer.id,
    fxRate: quote.rate ?? 1,
    status: 'drafted',
  };
}

export interface ServiceDraftResult {
  profileId: number;
  results: DraftOneResult[];
}

/** Draft a Wise transfer for each of the given payment IDs. OWNER-only. */
export async function serviceDraft(db: Db, paymentIds: string[]): Promise<ServiceDraftResult> {
  const profileId = await getBusinessProfileId();
  const rows = await fetchDraftPayments(db, paymentIds);
  const results: DraftOneResult[] = [];

  for (const row of rows) {
    const recipientId = row.workers?.wise_recipient_id ?? null;
    const amountPhp = Number(row.net_php ?? 0);

    if (!recipientId) {
      results.push({
        paymentId: row.id,
        status: 'skipped',
        error: 'no Wise recipient',
      });
      continue;
    }
    if (amountPhp <= 0) {
      results.push({
        paymentId: row.id,
        status: 'skipped',
        error: 'no amount',
      });
      continue;
    }

    const res = await draftOne(profileId, row.id, recipientId, amountPhp);
    if (res.status === 'drafted' && res.transferId !== undefined) {
      await setWiseTransferIdSafe(db, row.id, String(res.transferId), res.fxRate);
    }
    results.push(res);
  }

  return { profileId, results };
}

async function setWiseTransferIdSafe(
  db: Db,
  paymentId: string,
  transferId: string,
  fxRate?: number,
): Promise<void> {
  const update: Database['public']['Tables']['payments']['Update'] = {
    wise_transfer_id: transferId,
  };
  if (fxRate !== undefined) update.fx_rate = fxRate;
  await db.from('payments').update(update).eq('id', paymentId);
}

// ─── batch ────────────────────────────────────────────────────────────────────

export interface ServiceBatchResult {
  batchGroupId: string;
  profileId: number;
  results: DraftOneResult[];
}

/** Draft transfers inside a Wise batch group. OWNER-only. Does NOT complete/fund. */
export async function serviceBatch(
  db: Db,
  items: WiseBatchItem[],
  name?: string,
): Promise<ServiceBatchResult> {
  const profileId = await getBusinessProfileId();
  const overrides = new Map(items.map((i) => [i.paymentId, i]));
  const rows = await fetchDraftPayments(
    db,
    items.map((i) => i.paymentId),
  );
  const eligible = rows.filter((r) => {
    const { recipientId, amountPhp } = resolveDraftRow(r, overrides.get(r.id));
    return recipientId !== null && amountPhp > 0;
  });

  if (eligible.length === 0) throw new Error('No eligible payments (missing recipient or amount)');

  // 1. Create the batch group.
  const group = await wiseRequest<{ id: string }>(`/v3/profiles/${profileId}/batch-groups`, {
    method: 'POST',
    body: {
      name: name ?? `Payroll ${new Date().toISOString().slice(0, 10)}`,
      sourceCurrency: 'PHP',
    },
  });

  const results: DraftOneResult[] = [];

  for (const row of rows) {
    const { recipientId, amountPhp } = resolveDraftRow(row, overrides.get(row.id));

    if (!recipientId || amountPhp <= 0) {
      results.push({
        paymentId: row.id,
        status: 'skipped',
        error: !recipientId ? 'no Wise recipient' : 'no amount',
      });
      continue;
    }

    try {
      // Quote.
      const quote = await wiseRequest<{ id: string; rate?: number }>(
        `/v3/profiles/${profileId}/quotes`,
        {
          method: 'POST',
          body: {
            sourceCurrency: 'PHP',
            targetCurrency: 'PHP',
            targetAmount: amountPhp,
            payOut: 'BALANCE',
          },
        },
      );

      // Transfer inside the batch group.
      const t = await wiseRequest<{ id: number }>(
        `/v3/profiles/${profileId}/batch-groups/${group.id}/transfers`,
        {
          method: 'POST',
          body: {
            targetAccount: recipientId,
            quoteUuid: quote.id,
            customerTransactionId: crypto.randomUUID(),
            details: {
              reference: 'Payroll',
              transferPurpose: 'verification.transfers.purpose.pay.bills',
            },
          },
        },
      );

      // Write back to DB.
      await setWiseTransferIdSafe(db, row.id, String(t.id), quote.rate ?? 1);
      results.push({
        paymentId: row.id,
        transferId: t.id,
        fxRate: quote.rate ?? 1,
        status: 'drafted',
      });
    } catch (e) {
      results.push({ paymentId: row.id, status: 'failed', error: String(e) });
    }
  }

  // NOTE: we deliberately do NOT complete or fund the group. The owner reviews,
  // completes, and funds it in the Wise UI. Money has NOT moved.
  return { batchGroupId: group.id, profileId, results };
}

// ─── poll (reconcile) ─────────────────────────────────────────────────────────

export interface PollResultRow {
  paymentId: string;
  transferId: string;
  status: string;
  markedPaid?: boolean;
  paidAt?: string;
  inFlight?: boolean;
  error?: string;
}

export interface ServicePollResult {
  checked: number;
  markedPaid: number;
  inFlight: number;
  unknown: number;
  results: PollResultRow[];
}

/**
 * Server-side reconcile. Fetches every payment with a wise_transfer_id,
 * queries Wise, and updates payments.status to 'sent' for terminal-success
 * states. Idempotent. Safe to call manually or on a schedule.
 *
 * Note: the cron path (x-cron-secret) is handled by the deployed Deno edge
 * function (supabase/functions/wise-payouts/index.ts). This action covers the
 * on-demand admin-triggered reconcile path only.
 *
 * @param onlyDrafts   Default true — restrict to status='draft' (fast + idempotent).
 * @param payPeriodId  Optional scope to a single period.
 */
export async function servicePoll(
  db: Db,
  opts: { onlyDrafts?: boolean; payPeriodId?: string } = {},
): Promise<ServicePollResult> {
  const onlyDrafts = opts.onlyDrafts !== false;
  const payments = await fetchPollPayments(db, {
    onlyDrafts,
    ...(opts.payPeriodId ? { payPeriodId: opts.payPeriodId } : {}),
  });

  if (payments.length === 0) {
    return { checked: 0, markedPaid: 0, inFlight: 0, unknown: 0, results: [] };
  }

  const nowIso = new Date().toISOString();

  // Fetch every transfer's full detail in parallel (bounded concurrency = 8).
  const fetched = await mapLimit(payments, 8, async (p) => {
    try {
      const detail = await wiseRequest<Record<string, unknown>>(
        `/v1/transfers/${p.wise_transfer_id}`,
      );
      return { p, ok: true as const, detail };
    } catch {
      return { p, ok: false as const };
    }
  });

  let markedPaid = 0;
  let inFlight = 0;
  let unknown = 0;
  const results: PollResultRow[] = [];

  for (const f of fetched) {
    const { p } = f;
    if (!f.ok) {
      unknown++;
      results.push({
        paymentId: p.id,
        transferId: p.wise_transfer_id,
        status: 'unknown',
      });
      continue;
    }
    const wiseRow = f.detail;
    const st = String(wiseRow.status ?? '');

    if (WISE_PAID_STATES.has(st)) {
      // Use Wise's REAL sent date (or dateFunded / created as fallbacks) instead of
      // now(). Also captures the full wise_dates triple for the UI tooltip.
      const dates = wiseDatesFromRow(wiseRow);
      const realSent = bestSentDate(dates) ?? nowIso;
      try {
        await markPaymentSent(db, p.id, realSent, dates, nowIso);
        markedPaid++;
        results.push({
          paymentId: p.id,
          transferId: p.wise_transfer_id,
          status: st,
          markedPaid: true,
          paidAt: realSent,
        });
      } catch {
        results.push({
          paymentId: p.id,
          transferId: p.wise_transfer_id,
          status: st,
          error: 'db write failed',
        });
      }
    } else if (WISE_IN_FLIGHT_STATES.has(st)) {
      inFlight++;
      results.push({
        paymentId: p.id,
        transferId: p.wise_transfer_id,
        status: st,
        inFlight: true,
      });
    } else {
      // cancelled / funds_refunded / bounced_back / etc. — surface but don't change DB.
      results.push({
        paymentId: p.id,
        transferId: p.wise_transfer_id,
        status: st,
      });
    }
  }

  return { checked: payments.length, markedPaid, inFlight, unknown, results };
}

// ─── match (backfill) ─────────────────────────────────────────────────────────

export interface MatchStats {
  scanned: number;
  matched: number;
  variances: number;
  ambiguous: number;
  unmatched: number;
  wiseTransfersPulled: number;
  wiseTransfersLive: number;
  wiseTransfersCancelled: number;
  window: { from: string; to: string; days: number };
  mode: 'match' | 'refresh';
  results: MatchResult[];
}

/**
 * Backfill matcher. For payments missing a wise_transfer_id, pulls Wise's
 * transfer history for the relevant window and matches by recipient + amount + date.
 * Writes wise_transfer_id back only on UNAMBIGUOUS matches. Idempotent.
 *
 * See src/lib/wise/matcher.ts for the full matching logic and edge-case comments.
 *
 * @param windowDays   ±days around pay_date (default 7; legacy default).
 * @param refresh      Re-fetch already-matched rows (to backfill wise_dates etc.).
 * @param payPeriodId  Scope to one period (omit = all unmatched wise payments).
 */
export async function serviceMatch(
  db: Db,
  opts: {
    windowDays?: number | undefined;
    refresh?: boolean | undefined;
    payPeriodId?: string | undefined;
  } = {},
): Promise<MatchStats> {
  const windowDays = Number(opts.windowDays ?? 7);
  const refresh = opts.refresh === true;

  const payments = await fetchMatchPayments(db, {
    refresh,
    ...(opts.payPeriodId ? { payPeriodId: opts.payPeriodId } : {}),
  });

  if (payments.length === 0) {
    return {
      scanned: 0,
      matched: 0,
      variances: 0,
      ambiguous: 0,
      unmatched: 0,
      wiseTransfersPulled: 0,
      wiseTransfersLive: 0,
      wiseTransfersCancelled: 0,
      window: {
        from: new Date().toISOString(),
        to: new Date().toISOString(),
        days: windowDays,
      },
      mode: refresh ? 'refresh' : 'match',
      results: [],
    };
  }

  // 2. Compute the union date window across all candidate payments so we pull
  //    Wise transfers once. Pulling per-payment would be N API calls; pulling the
  //    union is 1 + paging.
  const dateMs = (p: (typeof payments)[0]): number => {
    const d = p.pay_periods?.pay_date ?? p.pay_periods?.period_end;
    return d ? new Date(d).getTime() : Date.now();
  };

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  for (const p of payments) {
    const t = dateMs(p);
    if (t < minTs) minTs = t;
    if (t > maxTs) maxTs = t;
  }

  // For the Wise API pull, use a generous window (min 45d) so historical periods
  // (where the DB pay_date may be weeks before the real Wise transfer date) still
  // surface their transfers. Per-row matching applies the tight windowDays filter.
  const pullPaddingDays = Math.max(windowDays, 45);
  const fromIso = new Date(minTs - pullPaddingDays * DAY_MS).toISOString();
  const toIso = new Date(maxTs + pullPaddingDays * DAY_MS).toISOString();

  // 3. Pull Wise transfer history for the union window with pagination.
  const profileId = await getBusinessProfileId();
  const wiseTransfers: WiseTransfer[] = [];
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
    wiseTransfers.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  // 4. Filter out cancelled "ghost" transfers.
  const liveTransfers = filterLive(wiseTransfers);

  // 5. Build indexes.
  const recipIndex = buildRecipientIndex(liveTransfers);
  const idIndex = buildTransferIdIndex(liveTransfers);

  // 6. Match each payment.
  const nowIso = new Date().toISOString();
  const allResults: MatchResult[] = [];
  let matched = 0;
  let variances = 0;
  let ambiguous = 0;
  let unmatched = 0;

  for (const p of payments) {
    // Build a MatcherPayment shape (compatible with pure matcher).
    const mp = {
      id: p.id,
      worker_id: p.worker_id,
      net_php: p.net_php,
      original_net_php: p.original_net_php,
      status: p.status,
      wise_transfer_id: p.wise_transfer_id,
      workers: p.workers
        ? {
            wise_recipient_id: p.workers.wise_recipient_id,
            wise_recipient_uuid: p.workers.wise_recipient_uuid,
            wise_recipients: p.workers.wise_recipients,
          }
        : null,
      pay_periods: p.pay_periods
        ? {
            pay_date: p.pay_periods.pay_date,
            period_end: p.pay_periods.period_end,
          }
        : null,
    };

    let decision: MatchDecision;
    if (refresh && p.wise_transfer_id) {
      // REFRESH FAST PATH: fetch detail dates from Wise for the stored transfer.
      const storedT = idIndex.get(String(p.wise_transfer_id));
      const dates: WiseDates = storedT
        ? await fetchWiseDates(storedT)
        : { created: null, dateFunded: null, dateSent: null };
      decision = decideRefresh(mp, idIndex, dates, nowIso);
    } else {
      // DISCOVERY PATH: fetch dates lazily only for the winning transfer.
      const getDates = (t: WiseTransfer): WiseDates => {
        // For the sync pure matcher call, return list-row dates (no network).
        // The service layer re-fetches the detail asynchronously below.
        return wiseDatesFromListRow(t);
      };
      decision = decideMatch(mp, recipIndex, getDates, windowDays, nowIso);

      // If the decision involves a transfer, fetch the real detail dates now.
      if (decision.patch?.wise_transfer_id) {
        const tid = decision.patch.wise_transfer_id;
        const t = idIndex.get(tid);
        if (t) {
          const realDates = await fetchWiseDates(t);
          decision.patch.wise_dates = realDates;
          // Re-evaluate paid_at / status from the real dates.
          const sentIso = bestSentDate(realDates);
          if (sentIso && WISE_PAID_STATES.has(t.status)) {
            decision.patch.paid_at = sentIso;
            decision.patch.status = 'sent';
            decision.patch.wise_locked_at = nowIso;
          }
          // Propagate updated dates to result for the response body.
          const r = decision.result;
          if ('wise_dates' in r) {
            (r as unknown as { wise_dates: WiseDates }).wise_dates = realDates;
          }
        }
      }
    }

    const { patch, result } = decision;

    // Apply DB write if the matcher proposed one.
    if (patch) {
      try {
        await applyMatchPatch(db, p.id, {
          ...(patch.wise_transfer_id !== undefined
            ? { wise_transfer_id: patch.wise_transfer_id }
            : {}),
          ...(patch.wise_dates !== undefined ? { wise_dates: patch.wise_dates } : {}),
          ...(patch.original_net_php !== undefined
            ? { original_net_php: patch.original_net_php }
            : {}),
          ...(patch.net_php !== undefined ? { net_php: patch.net_php } : {}),
          ...(patch.paid_at !== undefined ? { paid_at: patch.paid_at } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.wise_locked_at !== undefined ? { wise_locked_at: patch.wise_locked_at } : {}),
        });
      } catch {
        allResults.push({
          payment_id: p.id,
          worker_id: p.worker_id,
          outcome: 'db_write_failed',
          error: 'db write failed',
        });
        continue;
      }
    }

    allResults.push(result);

    // Tally counters.
    switch (result.outcome) {
      case 'matched_exact':
      case 'matched_closest_date':
      case 'refreshed_clean':
        matched++;
        break;
      case 'matched_with_variance_overridden':
      case 'matched_with_variance':
        variances++;
        break;
      case 'ambiguous_exact':
        ambiguous++;
        break;
      case 'no_recipient':
      case 'no_wise_transfer':
      case 'no_wise_transfer_in_window':
      case 'refresh_transfer_not_in_history':
        unmatched++;
        break;
      default:
        break;
    }
  }

  // 7. Orphan-transfer diagnostics: annotate unmatched results with candidate
  //    orphan transfers that weren't claimed by any DB row.
  // Convert MatcherPayment array for annotateOrphans.
  const matcherPayments = payments.map((p) => ({
    id: p.id,
    worker_id: p.worker_id,
    net_php: p.net_php,
    original_net_php: p.original_net_php,
    status: p.status,
    wise_transfer_id: p.wise_transfer_id,
    workers: p.workers,
    pay_periods: p.pay_periods
      ? {
          pay_date: p.pay_periods.pay_date,
          period_end: p.pay_periods.period_end,
        }
      : null,
  }));
  annotateOrphans(allResults, matcherPayments, liveTransfers, windowDays);

  return {
    scanned: payments.length,
    matched,
    variances,
    ambiguous,
    unmatched,
    wiseTransfersPulled: wiseTransfers.length,
    wiseTransfersLive: liveTransfers.length,
    wiseTransfersCancelled: wiseTransfers.length - liveTransfers.length,
    window: { from: fromIso, to: toIso, days: windowDays },
    mode: refresh ? 'refresh' : 'match',
    results: allResults,
  };
}

// ─── read-only lookups ────────────────────────────────────────────────────────

export interface WiseTransferStatus {
  id: string | number;
  status: string | null;
  error?: string;
}

export interface WiseRateRow {
  id: string | number;
  rate: number | null;
  status: string | null;
  sourceCurrency: string | null;
  targetCurrency: string | null;
  sourceValue: number | null;
  targetValue: number | null;
  targetAccount: number | null;
  reference: string | null;
  created: string | null;
  error?: string;
}

export interface WiseRecipient {
  id: number;
  name: string;
  currency: string;
  account: string;
  email: string | null;
  active: boolean;
}

export async function serviceStatus(
  transferIds: (string | number)[],
): Promise<WiseTransferStatus[]> {
  return mapLimit(transferIds, 8, async (id) => {
    try {
      const t = await wiseRequest<{ status: string }>(`/v1/transfers/${id}`);
      return { id, status: t.status ?? null };
    } catch {
      return { id, status: null, error: 'fetch failed' };
    }
  });
}

export async function serviceRates(transferIds: (string | number)[]): Promise<WiseRateRow[]> {
  return mapLimit(transferIds, 8, async (id) => {
    try {
      const t = await wiseRequest<Record<string, unknown>>(`/v1/transfers/${id}`);
      return {
        id,
        rate: (t.rate as number | null | undefined) ?? null,
        status: (t.status as string | null | undefined) ?? null,
        sourceCurrency: (t.sourceCurrency as string | null | undefined) ?? null,
        targetCurrency: (t.targetCurrency as string | null | undefined) ?? null,
        sourceValue: (t.sourceValue as number | null | undefined) ?? null,
        targetValue: (t.targetValue as number | null | undefined) ?? null,
        targetAccount: (t.targetAccount as number | null | undefined) ?? null,
        reference:
          ((t.details as Record<string, unknown> | null | undefined)?.reference as
            | string
            | null
            | undefined) ?? null,
        created: (t.created as string | null | undefined) ?? null,
      };
    } catch {
      return {
        id,
        rate: null,
        status: null,
        sourceCurrency: null,
        targetCurrency: null,
        sourceValue: null,
        targetValue: null,
        targetAccount: null,
        reference: null,
        created: null,
        error: `fetch failed for ${id}`,
      };
    }
  });
}

export async function serviceRecipients(profileId?: number): Promise<{
  profileId: number;
  recipients: WiseRecipient[];
}> {
  const pid = profileId ?? (await getBusinessProfileId());
  const accounts = await wiseRequest<Record<string, unknown>[]>(`/v1/accounts?profile=${pid}`);

  const recipients = (Array.isArray(accounts) ? accounts : []).map((a): WiseRecipient => {
    const d = (a.details as Record<string, unknown> | null | undefined) ?? {};
    const hint =
      (d.accountNumber as string | null | undefined) ??
      (d.iban as string | null | undefined) ??
      (d.email as string | null | undefined) ??
      '';
    const masked = hint ? `••••${String(hint).slice(-4)}` : '';
    return {
      id: a.id as number,
      name:
        (a.accountHolderName as string | null | undefined) ??
        (a.name as string | null | undefined) ??
        '',
      currency:
        (a.currency as string | null | undefined) ??
        (d.currency as string | null | undefined) ??
        '',
      account: masked,
      email: (d.email as string | null | undefined) ?? null,
      active: (a.active as boolean | null | undefined) !== false,
    };
  });

  return { profileId: pid, recipients };
}

/**
 * Build an admin-facing reason for a recipient that came back missing,
 * distinguishing a stale/deleted id from a systemic credential/environment
 * problem (when the token sees zero recipients). Call this ONLY on the miss
 * path — it performs one extra recipient-list request.
 */
export async function explainMissingRecipient(recipientId: number): Promise<string> {
  try {
    const { recipients } = await serviceRecipients();
    return missingRecipientReason(recipientId, recipients.length);
  } catch (e) {
    return (
      `Recipient ${recipientId} not found, and the Wise recipient list could not be loaded ` +
      `(${e instanceof Error ? e.message : String(e)}). Check WISE_API_TOKEN and connectivity.`
    );
  }
}

export async function serviceGetRecipient(recipientId: number): Promise<WiseRecipient | null> {
  const a = await wiseRequestNullable<Record<string, unknown>>(`/v1/accounts/${recipientId}`);
  if (!a) return null;
  const d = (a.details as Record<string, unknown> | null | undefined) ?? {};
  const hint =
    (d.accountNumber as string | null | undefined) ??
    (d.iban as string | null | undefined) ??
    (d.email as string | null | undefined) ??
    '';
  const masked = hint ? `••••${String(hint).slice(-4)}` : '';
  return {
    id: a.id as number,
    name:
      (a.accountHolderName as string | null | undefined) ??
      (a.name as string | null | undefined) ??
      '',
    currency:
      (a.currency as string | null | undefined) ?? (d.currency as string | null | undefined) ?? '',
    account: masked,
    email: (d.email as string | null | undefined) ?? null,
    active: (a.active as boolean | null | undefined) !== false,
  };
}

export interface ContactResult {
  id: unknown;
  name: string;
  accountHolderName: string;
  profileId: unknown;
  balanceRecipientId: unknown;
  avatar: unknown;
  hidden: boolean;
}

export async function serviceSearchContacts(
  term: string,
  profileId?: number,
): Promise<{
  profileId: number;
  searchTerm: string;
  contacts: ContactResult[];
}> {
  const pid = profileId ?? (await getBusinessProfileId());
  const contacts = await wiseRequest<Record<string, unknown>[]>(
    `/v1/profiles/${pid}/contacts?searchTerm=${encodeURIComponent(term)}`,
  );
  const list = (Array.isArray(contacts) ? contacts : []).map(
    (c): ContactResult => ({
      id: c.id,
      name:
        (c.name as string | null | undefined) ??
        (c.accountHolderName as string | null | undefined) ??
        '',
      accountHolderName: (c.accountHolderName as string | null | undefined) ?? '',
      profileId: c.profileId,
      balanceRecipientId: c.balanceRecipientId,
      avatar: c.avatar ?? null,
      hidden: !!(c.hidden as boolean | null | undefined),
    }),
  );
  return { profileId: pid, searchTerm: term, contacts: list };
}

export interface TransferMatch {
  id: number;
  status: string;
  targetAccount: number | string | null;
  targetValue: number | null;
  targetCurrency: string | null;
  created: string | null;
  reference: string | null;
}

export async function serviceFindTransfersByRecipient(
  recipientId: number,
  opts: { fromIso?: string; toIso?: string } = {},
): Promise<{
  recipientId: number;
  window: { from: string; to: string };
  totalInWindow: number;
  matchesForRecipient: number;
  matches: TransferMatch[];
}> {
  const toIso = opts.toIso ? new Date(opts.toIso).toISOString() : new Date().toISOString();
  const fromIso = opts.fromIso
    ? new Date(opts.fromIso).toISOString()
    : new Date(Date.now() - 90 * DAY_MS).toISOString();

  const profileId = await getBusinessProfileId();
  const all: WiseTransfer[] = [];
  let offset = 0;
  const pageSize = 100;

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

  const matches = all.filter((t) => String(t.targetAccount) === String(recipientId));

  return {
    recipientId,
    window: { from: fromIso, to: toIso },
    totalInWindow: all.length,
    matchesForRecipient: matches.length,
    matches: matches.map((t) => ({
      id: t.id,
      status: t.status,
      targetAccount: t.targetAccount ?? null,
      targetValue: t.targetValue ?? null,
      targetCurrency: null,
      created: t.created ?? t.createdAt ?? null,
      reference: null,
    })),
  };
}
