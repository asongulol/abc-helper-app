import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { updatePaymentRow } from '@/db/queries/payroll';
import {
  appendPaymentNote,
  applyMatchPatch,
  clearPaymentLink,
  fetchClaimedTransferIds,
  fetchDraftPayments,
  fetchMatchPayments,
  fetchPollPayments,
  findPaymentByTransferId,
  markPaymentSent,
} from '@/db/queries/wise';
import type { Database } from '@/db/types';
import { fullName } from '@/lib/names';
import { bestSentDate, wiseDatesFromListRow, wiseDatesFromRow } from '@/lib/wise/dates';
import { classifyDraftError } from '@/lib/wise/draft-error';
import { type DraftOverride, resolveDraftRow } from '@/lib/wise/draft-row';
import {
  annotateOrphans,
  buildRecipientIndex,
  buildTransferIdIndex,
  decideMatch,
  decideRefresh,
  filterLive,
} from '@/lib/wise/matcher';
import { missingRecipientReason } from '@/lib/wise/recipient-miss';
import { type PeriodWindow, referenceMatchesPeriod } from '@/lib/wise/reference';
import type {
  MatchDecision,
  MatchResult,
  OrphanCandidate,
  UnlinkedPayment,
  WiseDates,
  WiseTransfer,
} from '@/lib/wise/types';
import { isCancellable, WISE_IN_FLIGHT_STATES, WISE_PAID_STATES } from '@/lib/wise/types';
import type { WiseBatchItem } from '@/types/schemas/wise';
import {
  type AttributableRow,
  type AttributionRecord,
  type AttributionTarget,
  planAttribution,
  planUndo,
} from './attribution';
import { wiseRequest, wiseRequestNullable } from './client';

type Db = SupabaseClient<Database>;

const DAY_MS = 86_400_000;

/** Detail calls spent breaking one ambiguous row. Enough for a same-amount
 *  cluster (the biggest seen is 5), small enough to stay cheap. */
const MAX_REFERENCE_PROBES = 6;

/** The period bounds a reference is judged against. */
const periodWindow = (p: {
  pay_periods?: {
    period_start?: string | null;
    period_end?: string | null;
    pay_date?: string | null;
  } | null;
}): PeriodWindow => ({
  periodStart: p.pay_periods?.period_start ?? null,
  periodEnd: p.pay_periods?.period_end ?? null,
  payDate: p.pay_periods?.pay_date ?? null,
});

/** The recipient index narrowed to ONE transfer, so decideMatch re-runs its own
 *  window and amount rules against the candidate the reference named rather than
 *  the caller hand-linking it. */
const singleTransferIndex = (
  index: Map<string, WiseTransfer[]>,
  transferId: string,
): Map<string, WiseTransfer[]> => {
  const out = new Map<string, WiseTransfer[]>();
  for (const [k, list] of index) {
    const keep = list.filter((t) => String(t.id) === transferId);
    if (keep.length > 0) out.set(k, keep);
  }
  return out;
};

// ─── profile id cache ─────────────────────────────────────────────────────────

// The Wise business profile id is constant for the account. Memoize at module
// scope so warm Next.js instances skip the redundant GET /v2/profiles round-trip.
// Only the resolved value is cached; a thrown fetch never poisons the cache.
let cachedProfileId: number | null = null;

export async function getBusinessProfileId(): Promise<number> {
  if (cachedProfileId != null) return cachedProfileId;
  const profiles = await wiseRequest<{ id: number; type: string }[]>('/v2/profiles');
  // Wise returns type as "BUSINESS"/"PERSONAL" (uppercase) — compare case-insensitively.
  const biz = profiles.find((p) => p.type?.toUpperCase() === 'BUSINESS') ?? profiles[0];
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
  return (await fetchWiseDetail(listRow)).dates;
}

/**
 * Dates AND `details.reference` in one call. The reference is only returned by
 * the detail endpoint, and this path already pays for that call — so the
 * strongest signal available about which period a transfer paid costs nothing
 * extra to read. See lib/wise/reference.ts.
 */
async function fetchWiseDetail(
  listRow: WiseTransfer,
): Promise<{ dates: WiseDates; reference: string | null }> {
  const dates = wiseDatesFromListRow(listRow);
  let reference: string | null = null;
  try {
    const detail = await wiseRequest<Record<string, unknown>>(`/v1/transfers/${listRow.id}`);
    const d = wiseDatesFromRow(detail);
    dates.dateFunded = d.dateFunded;
    dates.dateSent = d.dateSent;
    if (!dates.created) dates.created = d.created;
    const details = detail.details as { reference?: unknown } | null | undefined;
    const raw = details?.reference ?? detail.reference;
    reference = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  } catch {
    // best-effort — keep created at minimum
  }
  return { dates, reference };
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
    return { paymentId, status: 'failed', error: classifyDraftError('transfer: ', e) };
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

export interface DraftableRow {
  wise_transfer_id?: string | null;
  net_php: number | null;
  status?: string | null;
  paid_at?: string | null;
  workers?: { wise_recipient_id?: number | null } | null;
}

/**
 * Triage one row before drafting: either the reason to skip it, or the
 * recipient + amount to draft. Shared by BOTH draft paths so the guards can't
 * drift apart — the UI filters are advisory only (two admins, or two tabs, both
 * see the same row as undrafted).
 *
 * A row that already carries a `wise_transfer_id` is NEVER re-drafted: the
 * write-back overwrites the stored id, orphaning the first (still live)
 * transfer, and funding the batch then pays the contractor twice (RP-09).
 *
 * Nor is a row that is already paid. The id was the only thing standing between
 * a paid row and a second draft, so unlinking one (to correct a wrong link) used
 * to hand it straight back to the draft path.
 */
export const triageDraftRow = (
  row: DraftableRow,
  override?: DraftOverride,
): { skip: string } | { recipientId: number; amountPhp: number } => {
  if (row.wise_transfer_id) return { skip: 'already drafted' };
  if (row.paid_at || row.status === 'sent' || row.status === 'reconciled') {
    return { skip: 'already paid' };
  }
  const { recipientId, amountPhp } = resolveDraftRow(row, override);
  if (!recipientId) return { skip: 'no Wise recipient' };
  if (amountPhp <= 0) return { skip: 'no amount' };
  return { recipientId, amountPhp };
};

/** Draft a Wise transfer for each of the given payment IDs. OWNER-only. */
export async function serviceDraft(db: Db, paymentIds: string[]): Promise<ServiceDraftResult> {
  const profileId = await getBusinessProfileId();
  const rows = await fetchDraftPayments(db, paymentIds);
  const results: DraftOneResult[] = [];

  for (const row of rows) {
    const triage = triageDraftRow(row);
    if ('skip' in triage) {
      results.push({ paymentId: row.id, status: 'skipped', error: triage.skip });
      continue;
    }

    const res = await draftOne(profileId, row.id, triage.recipientId, triage.amountPhp);
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
  const eligible = rows.filter((r) => !('skip' in triageDraftRow(r, overrides.get(r.id))));

  if (eligible.length === 0)
    throw new Error('No eligible payments (already drafted, or missing recipient or amount)');

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
    const triage = triageDraftRow(row, overrides.get(row.id));

    if ('skip' in triage) {
      results.push({ paymentId: row.id, status: 'skipped', error: triage.skip });
      continue;
    }
    const { recipientId, amountPhp } = triage;

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
      results.push({ paymentId: row.id, status: 'failed', error: classifyDraftError('', e) });
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
  /** Rows the matcher declined, each with the transfers that could be it. */
  unlinked: UnlinkedPayment[];
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
 * @param dryRun       Decide everything, write nothing. Opening a period runs
 *                     this to show its suggestions; only the explicit Match
 *                     button may link a transfer or restate an amount.
 */
export async function serviceMatch(
  db: Db,
  opts: {
    windowDays?: number | undefined;
    refresh?: boolean | undefined;
    payPeriodId?: string | undefined;
    dryRun?: boolean | undefined;
  } = {},
): Promise<MatchStats> {
  const windowDays = Number(opts.windowDays ?? 7);
  const refresh = opts.refresh === true;
  const dryRun = opts.dryRun === true;

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
      unlinked: [],
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

  // 5. Build indexes. One transfer pays one row, so anything a payment already
  //    holds is off the table before the matcher ever sees it — the discovery
  //    path is what put 36 transfers on two rows each. The by-id index keeps the
  //    full list: the refresh path has to find the transfer a row already claims.
  const claimed = await fetchClaimedTransferIds(db);
  const unclaimed = liveTransfers.filter((t) => !claimed.has(String(t.id)));
  const recipIndex = buildRecipientIndex(unclaimed);
  // Cancelled ghosts included on purpose: a row linked to one has to be able to
  // find it, or its dead link reports as "not in the history window" and looks
  // like a paging problem instead of the ghost it is.
  const idIndex = buildTransferIdIndex(wiseTransfers);

  // 6. Match each payment.
  const nowIso = new Date().toISOString();
  const allResults: MatchResult[] = [];
  /** Payments this run leaves carrying a transfer id. */
  const linkedPaymentIds = new Set<string>();
  /** dry-run only: payment id → the transfer a real run would have linked. */
  const proposed = new Map<string, string>();
  /** Transfers this run has already handed out — one transfer pays one row. */
  const taken = new Set<string>();
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
      // RP-04: the matcher anchors its date window on paid_at when we have it —
      // a real send date beats a derived one. It was selected but never passed,
      // so every row fell through to the date-derived window.
      paid_at: p.paid_at,
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
            period_start: p.pay_periods.period_start,
            period_end: p.pay_periods.period_end,
          }
        : null,
    };

    // DISCOVERY PATH: fetch dates lazily only for the winning transfer.
    const discover = async (m: typeof mp): Promise<MatchDecision> => {
      const getDates = (t: WiseTransfer): WiseDates => {
        // For the sync pure matcher call, return list-row dates (no network).
        // The service layer re-fetches the detail asynchronously below.
        return wiseDatesFromListRow(t);
      };
      let d = decideMatch(m, recipIndex, getDates, windowDays, nowIso, taken);

      // AMBIGUITY BREAKER: the matcher refuses to guess between same-amount
      // candidates, but their references usually say outright which period each
      // one paid. A handful of extra detail calls, only on rows that are stuck.
      if (d.result.outcome === 'ambiguous_exact') {
        const named: string[] = [];
        for (const id of d.result.candidate_transfer_ids.slice(0, MAX_REFERENCE_PROBES)) {
          const t = idIndex.get(id);
          if (!t) continue;
          const { reference } = await fetchWiseDetail(t);
          if (referenceMatchesPeriod(reference, periodWindow(m)) === true) named.push(id);
        }
        // Exactly one claiming this period resolves it; two still means guess.
        if (named.length === 1) {
          d = decideMatch(
            m,
            singleTransferIndex(recipIndex, named[0] as string),
            getDates,
            windowDays,
            nowIso,
            taken,
          );
        }
      }

      // If the decision involves a transfer, fetch the real detail dates now.
      if (d.patch?.wise_transfer_id) {
        const t = idIndex.get(d.patch.wise_transfer_id);
        if (t) {
          const { dates: realDates, reference } = await fetchWiseDetail(t);

          // DUPLICATE GUARD: a transfer whose reference names a DIFFERENT period
          // is the previous batch's, sitting in this period's window because the
          // window is deliberately generous. Auto-linking it marks a period paid
          // that nobody paid. Refuse and hand the operator the evidence.
          if (referenceMatchesPeriod(reference, periodWindow(m)) === false) {
            return {
              result: {
                payment_id: m.id,
                worker_id: m.worker_id,
                outcome: 'reference_names_other_period',
                transfer_id: String(t.id),
                reference: reference ?? '',
                reason: `Wise transfer ${t.id} says "${reference}" — that is not this period. Link it by hand if it really paid this row.`,
              },
            };
          }

          d.patch.wise_dates = realDates;
          // Re-evaluate paid_at / status from the real dates.
          const sentIso = bestSentDate(realDates);
          if (sentIso && WISE_PAID_STATES.has(t.status)) {
            d.patch.paid_at = sentIso;
            d.patch.status = 'sent';
            d.patch.wise_locked_at = nowIso;
          }
          // Propagate updated dates to result for the response body.
          const r = d.result;
          if ('wise_dates' in r) {
            (r as unknown as { wise_dates: WiseDates }).wise_dates = realDates;
          }
        }
      }
      return d;
    };

    let decision: MatchDecision;
    if (refresh && p.wise_transfer_id) {
      // REFRESH FAST PATH: fetch detail dates from Wise for the stored transfer.
      const storedT = idIndex.get(String(p.wise_transfer_id));
      const dates: WiseDates = storedT
        ? await fetchWiseDates(storedT)
        : { created: null, dateFunded: null, dateSent: null };
      decision = decideRefresh(mp, idIndex, dates, nowIso);

      // The stored transfer is cancelled/refunded — it paid nobody, so the row is
      // effectively unlinked and the transfer that DID pay it is still sitting
      // unclaimed. Re-run discovery here rather than making the operator unlink by
      // hand first. An unfunded draft is left alone deliberately: it is still live
      // in Wise, and orphaning it is the RP-09 double-pay route.
      if (decision.result.outcome === 'refresh_transfer_dead') {
        const relinked = await discover({ ...mp, wise_transfer_id: null });
        if (relinked.patch?.wise_transfer_id) decision = relinked;
      }
    } else {
      decision = await discover(mp);
    }

    const { patch, result } = decision;

    // A row is "unlinked" when the run leaves it without a transfer — not when
    // its outcome happens to be one of a named few. Listing by outcome dropped
    // ambiguous_exact rows out of the UI entirely: the period counted them as
    // unmatched and then showed nothing to act on.
    // A link to a transfer that never paid is not a link. Counting it as one is
    // what hid 29 ghost-linked rows: they were "linked", so the period looked
    // fully reconciled and they never appeared in the list of rows to act on.
    const deadLink =
      result.outcome === 'refresh_transfer_dead' || result.outcome === 'refresh_transfer_unfunded';
    if (patch?.wise_transfer_id || (p.wise_transfer_id && !deadLink)) linkedPaymentIds.add(p.id);
    if (dryRun && patch?.wise_transfer_id) proposed.set(p.id, patch.wise_transfer_id);
    // Claim it for the rest of the run — in a dry run too, or the read-only view
    // would offer one transfer to two rows and both would look linkable.
    if (patch?.wise_transfer_id) taken.add(patch.wise_transfer_id);

    // Apply DB write if the matcher proposed one.
    if (patch && !dryRun) {
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
      case 'refresh_transfer_dead':
      case 'refresh_transfer_unfunded':
      case 'reference_names_other_period':
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
    paid_at: p.paid_at, // same anchor as above, for orphan suggestions
    worker_name: p.workers
      ? fullName({
          firstName: p.workers.first_name,
          middleName: p.workers.middle_name,
          lastName: p.workers.last_name,
        })
      : null,
    workers: p.workers,
    pay_periods: p.pay_periods
      ? {
          pay_date: p.pay_periods.pay_date,
          period_start: p.pay_periods.period_start,
          period_end: p.pay_periods.period_end,
        }
      : null,
  }));

  // Recipient names give the sweep its second axis (amount alone can't tell two
  // contractors on a round ₱10,000 apart). One extra API call, and only when a
  // row actually needs the fallback.
  const needsFallback = allResults.some(
    (r) =>
      r.outcome === 'no_wise_transfer' ||
      r.outcome === 'no_wise_transfer_in_window' ||
      r.outcome === 'no_recipient',
  );
  let recipientNames: Map<string, string> | undefined;
  if (needsFallback) {
    try {
      const { recipients } = await serviceRecipients(profileId);
      const names = new Map(recipients.map((r) => [String(r.id), r.name] as [string, string]));
      // ponytail: one GET per since-deleted recipient (9 across all of 2024–2026),
      // so no caching or paging. Batch it if the recipient list ever churns hard.
      const extra = await mapLimit(unknownTargetAccounts(unclaimed, names), 8, (id) =>
        serviceGetRecipient(Number(id)).catch(() => null),
      );
      for (const r of extra) if (r?.name) names.set(String(r.id), r.name);
      recipientNames = names;
    } catch {
      // Names are an enhancement — fall back to the amount-only sweep.
      recipientNames = undefined;
    }
  }
  // Suggestions come from the same unclaimed pool: a transfer that already paid
  // another row is not an orphan, and offering it invites a second link to it.
  annotateOrphans(allResults, matcherPayments, unclaimed, windowDays, recipientNames);

  const netByPayment = new Map(payments.map((p) => [p.id, Number(p.net_php ?? 0)]));
  const nameByPayment = new Map(matcherPayments.map((p) => [p.id, p.worker_name ?? '']));

  /** The transfer a dry run would have linked, as a pickable candidate. */
  const proposedCandidate = (paymentId: string): OrphanCandidate[] => {
    const t = idIndex.get(proposed.get(paymentId) ?? '');
    if (!t) return [];
    return [
      {
        transfer_id: String(t.id),
        target_account: String(t.targetAccount ?? ''),
        target_value: Number(t.targetValue ?? t.targetAmount ?? 0),
        created: t.created ?? t.createdAt ?? null,
        wise_status: t.status ?? null,
        shared_with_n_payments: 1,
        ambiguous: false,
        recipient_name: recipientNames?.get(String(t.targetAccount ?? '')) ?? null,
        name_matches: false,
      },
    ];
  };

  const unlinked: UnlinkedPayment[] = allResults
    .filter((r) => !linkedPaymentIds.has(r.payment_id))
    .map((r) => ({
      paymentId: r.payment_id,
      workerName: nameByPayment.get(r.payment_id) ?? '',
      netPhp: netByPayment.get(r.payment_id) ?? 0,
      outcome: r.outcome,
      reason: 'reason' in r ? r.reason : 'error' in r ? r.error : 'Not linked to a Wise transfer',
      candidates:
        ('candidate_orphan_transfers' in r ? r.candidate_orphan_transfers : undefined) ??
        proposedCandidate(r.payment_id),
    }))
    // Rows we can actually offer a candidate for come first.
    .sort((a, b) => b.candidates.length - a.candidates.length);

  return {
    unlinked,
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

/**
 * Target accounts in the pulled transfers that the recipient list can't name.
 *
 * GET /v1/accounts?profile= returns ACTIVE recipients only, so a transfer sent to a
 * since-deleted recipient comes back nameless — and that is exactly the case the
 * orphan sweep exists for (recipient re-created, second account, paid via Wisetag).
 * Nameless, it has only the date window to go on, so a transfer sent later in the
 * legal pay window stays invisible while the row reports "no Wise transfer".
 * GET /v1/accounts/{id} still resolves a deleted recipient, so fetch those by id.
 */
export const unknownTargetAccounts = (
  transfers: WiseTransfer[],
  known: Map<string, string>,
): string[] => [
  ...new Set(transfers.map((t) => String(t.targetAccount ?? '')).filter((a) => a && !known.has(a))),
];

// ─── manual link ──────────────────────────────────────────────────────────────

export interface LinkTransferResult {
  transferId: string;
  wiseStatus: string | null;
  wiseAmount: number;
  dbAmount: number;
  /** wiseAmount − dbAmount, in pesos. Non-zero means the operator accepted a
   *  variance; the stored net is left alone either way. */
  delta: number;
  /** The transfer left outside the window the matcher searches — the operator
   *  asserted the link and gave a reason. */
  outOfWindow?: boolean;
}

/**
 * Attach a specific Wise transfer to a payment, by operator decision.
 *
 * The escape hatch for what the automatic matcher can't key on — a transfer
 * sent to a recipient the profile never knew about. Bookkeeping only: no money
 * moves and no new transfer is created.
 *
 * Unlike the auto-matcher's variance path, this NEVER rewrites net_php. The
 * operator is asserting "this transfer paid this row", not "the amount I
 * calculated was wrong" — silently restating the payroll amount from a
 * hand-picked transfer is how a typo becomes the record.
 */
export async function serviceLinkTransfer(
  db: Db,
  paymentId: string,
  transferId: string,
  dbAmount: number,
  opts: {
    /** Operator's reason — required when the transfer sits outside the period's
     *  window, where the automatic matcher would never have offered it. */
    reason?: string | undefined;
    note?: string | null | undefined;
    window?: { periodStart: string | null; payDate: string | null } | undefined;
  } = {},
): Promise<LinkTransferResult> {
  // One transfer pays one row. The matcher drops claimed transfers before it
  // indexes; the manual path had no such check, and unlink is what made a
  // second claim reachable by hand.
  const holder = await findPaymentByTransferId(db, String(transferId), paymentId);
  if (holder) {
    throw new Error(
      `Transfer ${transferId} is already linked to ${holder.workerName || 'another payment'}. Unlink it there first.`,
    );
  }

  const detail = await wiseRequest<Record<string, unknown>>(`/v1/transfers/${transferId}`);
  const status = (detail.status as string | null | undefined) ?? null;
  if (status === 'cancelled') {
    throw new Error(`Wise transfer ${transferId} is cancelled — it never paid anyone.`);
  }
  if (status && !WISE_PAID_STATES.has(status)) {
    throw new Error(
      `Wise transfer ${transferId} is ${status} — it hasn't paid anyone yet, so it can't be the transfer that paid this row.`,
    );
  }

  const dates = wiseDatesFromRow(detail);
  const sentIso = bestSentDate(dates);
  const wiseAmount = Number(detail.targetValue ?? 0);

  // Outside the window the matcher searches, the link is a claim only the
  // operator can make — Zagado's 2024-08-16→31 was paid three days before the
  // period opened. Allowed, but it has to say why, or the reason dies with the
  // session it was decided in.
  const outOfWindow = isOutsideWindow(sentIso ?? dates.created, opts.window);
  const reason = opts.reason?.trim();
  if (outOfWindow && !reason) {
    throw new Error(
      `Transfer ${transferId} was sent outside this period's payment window — add a reason to link it anyway.`,
    );
  }

  await applyMatchPatch(db, paymentId, {
    wise_transfer_id: String(transferId),
    wise_dates: dates,
    // Only claim it was paid when Wise says the money actually left.
    ...(sentIso && status && WISE_PAID_STATES.has(status)
      ? { paid_at: sentIso, status: 'sent', wise_locked_at: new Date().toISOString() }
      : {}),
  });

  if (reason) {
    await appendPaymentNote(db, paymentId, `Linked #${transferId}: ${reason}`, opts.note ?? null);
  }

  return {
    transferId: String(transferId),
    wiseStatus: status,
    wiseAmount,
    dbAmount,
    delta: wiseAmount - dbAmount,
    outOfWindow,
  };
}

/**
 * Sent before the period opened, or later than a fortnight past its deadline.
 *
 * The boundary between "the matcher could have found this itself" and "only the
 * operator can assert this" — outside it, a link needs a written reason. Unknown
 * dates are treated as inside: a missing pay_date is not evidence of anything,
 * and demanding a reason for it would just train people to type "n/a".
 */
export const isOutsideWindow = (
  sentIso: string | null,
  window?: { periodStart: string | null; payDate: string | null } | undefined,
): boolean => {
  if (!sentIso || !window?.periodStart || !window.payDate) return false;
  const sent = new Date(sentIso).getTime();
  if (Number.isNaN(sent)) return false;
  const lo = new Date(`${window.periodStart}T00:00:00.000Z`).getTime();
  const hi = new Date(`${window.payDate}T23:59:59.999Z`).getTime() + 14 * DAY_MS;
  return sent < lo || sent > hi;
};

export interface UnlinkTransferResult {
  paymentId: string;
  transferId: string;
  wiseStatus: string | null;
}

/**
 * Detach the transfer a payment holds, with a reason.
 *
 * The counterpart `wiseLinkTransfer` has told operators to use since it shipped
 * ("Already linked to transfer X. Unlink it first.") — a button nobody had built.
 *
 * Refuses while the linked transfer is an unfunded draft: that transfer is still
 * live in Wise, and a row with no transfer id is draftable again, so unlinking it
 * is the RP-09 double-pay route with extra steps. Cancel it in Wise first.
 */
export async function serviceUnlinkTransfer(
  db: Db,
  payment: { id: string; wise_transfer_id: string | null; status: string; note: string | null },
  reason: string,
): Promise<UnlinkTransferResult> {
  const transferId = payment.wise_transfer_id;
  if (!transferId) throw new Error('This payment is not linked to a Wise transfer.');

  // A transfer we can't read is one we can't call live, so it can't block the
  // unlink — but an in-flight draft we CAN read must.
  const detail = await wiseRequestNullable<Record<string, unknown>>(`/v1/transfers/${transferId}`);
  const status = (detail?.status as string | null | undefined) ?? null;
  if (status && WISE_IN_FLIGHT_STATES.has(status)) {
    throw new Error(
      `Transfer ${transferId} is ${status} — an unfunded draft that is still live in Wise. Cancel it first ("Cancel draft in Wise"), or funding it later pays this row twice.`,
    );
  }

  await clearPaymentLink(db, payment.id, {
    note: `Unlinked #${transferId}: ${reason}`,
    status: payment.status,
    existingNote: payment.note,
  });

  return { paymentId: payment.id, transferId, wiseStatus: status };
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
 * Search Wise CONTACTS (Wise-to-Wise / balance recipients) by Wisetag or name.
 *
 * GET /v1/profiles/{pid}/contacts?searchTerm= returns each contact's `id` (a
 * UUID) and `balanceRecipientId` (numeric). Verified against live data: the
 * contact `id` IS the manual Batch-CSV `recipientId` (== wise_recipient_uuid),
 * and `balanceRecipientId` IS wise_recipient_id. So one lookup yields both ids
 * a balance/Wisetag contractor needs — no manual UUID paste.
 *
 * ponytail: Wise IGNORES ?searchTerm here and returns the first page of contacts
 * regardless — the caller filters by name client-side. Page-size limit unhandled
 * (the account has ~9 balance contacts); add cursor paging if that set grows.
 */
export async function serviceSearchContacts(
  term: string,
  profileId?: number,
): Promise<{ uuid: string; recipientId: number; name: string }[]> {
  const pid = profileId ?? (await getBusinessProfileId());
  const raw = await wiseRequest<Record<string, unknown>[]>(
    `/v1/profiles/${pid}/contacts?searchTerm=${encodeURIComponent(term)}`,
  );
  return (Array.isArray(raw) ? raw : [])
    .map((c) => ({
      uuid: String((c.id as string | number | null | undefined) ?? ''),
      recipientId: Number(c.balanceRecipientId ?? 0),
      name:
        (c.name as string | null | undefined) ??
        (c.accountHolderName as string | null | undefined) ??
        '',
    }))
    .filter((c) => /-/.test(c.uuid)); // keep real UUID contacts only (batch-CSV key)
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

// ─── variance attribution ─────────────────────────────────────────────────────

/** The payment columns an attribution reads and writes. */
export interface AttributionPayment extends AttributableRow {
  id: string;
  net_php: number | null;
  wise_transfer_id: string | null;
}

export interface AttributionResult {
  delta: number;
  netPhp: number;
  wiseAmount: number;
  prevValue: number | null;
  label: string | null;
}

/**
 * Explain the gap between what payroll says and what Wise sent, by putting it
 * somewhere on the row.
 *
 * The delta is read from the transfer, never from the caller — the control can
 * only ever close the gap it was opened for, which is what makes it safe to run
 * on a locked or paid period where the ordinary editor refuses.
 */
export async function serviceAttributeVariance(
  db: Db,
  payment: AttributionPayment,
  opts: { target: AttributionTarget; label?: string | undefined; companyId?: string | undefined },
): Promise<AttributionResult> {
  if (!payment.wise_transfer_id) {
    throw new Error('Link the Wise transfer first — there is no variance until there is a link.');
  }

  const detail = await wiseRequest<Record<string, unknown>>(
    `/v1/transfers/${payment.wise_transfer_id}`,
  );
  const wiseAmount = Number(detail.targetValue ?? 0);
  const delta = wiseAmount - Number(payment.net_php ?? 0);

  const plan = planAttribution(payment, {
    delta,
    target: opts.target,
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(opts.companyId !== undefined ? { companyId: opts.companyId } : {}),
  });

  await updatePaymentRow(db, payment.id, {
    ...(plan.haPhp !== undefined ? { haPhp: plan.haPhp } : {}),
    ...(plan.t13Php !== undefined ? { t13Php: plan.t13Php } : {}),
    ...(plan.miscItems !== undefined ? { miscItems: plan.miscItems } : {}),
    netPhp: plan.netPhp,
  });

  return {
    delta,
    netPhp: plan.netPhp,
    wiseAmount,
    prevValue: plan.prevValue,
    label: plan.item?.label ?? null,
  };
}

/** Reverse the last attribution on a payment — see `planUndo`. */
export async function serviceUndoAttribution(
  db: Db,
  payment: AttributionPayment,
  record: AttributionRecord,
): Promise<{ netPhp: number }> {
  const plan = planUndo(payment, record);
  await updatePaymentRow(db, payment.id, {
    ...(plan.haPhp !== undefined ? { haPhp: plan.haPhp } : {}),
    ...(plan.t13Php !== undefined ? { t13Php: plan.t13Php } : {}),
    ...(plan.miscItems !== undefined ? { miscItems: plan.miscItems } : {}),
    netPhp: plan.netPhp,
  });
  return { netPhp: plan.netPhp };
}

// ─── cancel a draft ───────────────────────────────────────────────────────────

export interface CancelTransferResult {
  transferId: string;
  previousStatus: string;
  status: string;
}

/**
 * Cancel an unfunded Wise transfer the app is holding.
 *
 * The counterpart to drafting, and the step that unblocks everything else: while
 * a draft is live the app refuses to unlink or re-match its row (orphaning a
 * fundable transfer is the RP-09 double-pay route), so without a cancel button
 * the only exit was the Wise UI.
 *
 * This is NOT a funding call and does not contradict ADR-0007 — it is the one
 * direction that can only ever reduce money movement. Refuses anything that has
 * already paid: `PUT /transfers/{id}/cancel` on a sent transfer is a no-op in
 * Wise, and the operator needs to be told they are looking at real money, not
 * handed a raw API error.
 */
export async function serviceCancelTransfer(
  db: Db,
  payment: { id: string; wise_transfer_id: string | null; note: string | null },
  reason?: string,
): Promise<CancelTransferResult> {
  const transferId = payment.wise_transfer_id;
  if (!transferId) throw new Error('This payment is not linked to a Wise transfer.');

  const detail = await wiseRequest<Record<string, unknown>>(`/v1/transfers/${transferId}`);
  const previousStatus = String(detail.status ?? '');
  if (WISE_PAID_STATES.has(previousStatus)) {
    throw new Error(
      `Transfer ${transferId} is ${previousStatus} — that money has already gone out. Nothing to cancel.`,
    );
  }
  if (!isCancellable(previousStatus)) {
    throw new Error(`Transfer ${transferId} is ${previousStatus} — it cannot be cancelled.`);
  }

  const cancelled = await wiseRequest<Record<string, unknown>>(
    `/v1/transfers/${transferId}/cancel`,
    { method: 'PUT' },
  );
  const status = String(cancelled.status ?? 'cancelled');

  await appendPaymentNote(
    db,
    payment.id,
    `Cancelled draft #${transferId}${reason ? `: ${reason}` : ''}`,
    payment.note,
  );

  return { transferId, previousStatus, status };
}
