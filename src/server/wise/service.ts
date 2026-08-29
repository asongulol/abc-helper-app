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
import { bestSentDate } from '@/lib/wise/dates';
import { classifyDraftError } from '@/lib/wise/draft-error';
import { type DraftOverride, resolveDraftRow } from '@/lib/wise/draft-row';
import { type MatchTally, tallyMatch } from '@/lib/wise/match-summary';
import { filterLive } from '@/lib/wise/matcher';
import { missingRecipientReason } from '@/lib/wise/recipient-miss';
import type { MatchResult, UnlinkedPayment } from '@/lib/wise/types';
import { isCancellable, WISE_IN_FLIGHT_STATES, WISE_PAID_STATES } from '@/lib/wise/types';
import type { WiseBatchItem } from '@/types/schemas/wise';
import { realWiseApi, type WiseApi, type WiseQuote, type WiseRecipient } from './api';
import {
  type AttributableRow,
  type AttributionRecord,
  type AttributionTarget,
  planAttribution,
  planUndo,
} from './attribution';
import { mapLimit, planMatchRun } from './plan-match';

// Recipient/transfer/contact types live with the seam now; re-exported so
// existing importers keep working.
export type { WiseContact, WiseRecipient, WiseTransferDetail } from './api';

type Db = SupabaseClient<Database>;

const DAY_MS = 86_400_000;

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
  api: WiseApi,
  profileId: number,
  paymentId: string,
  recipientId: number,
  amountPhp: number,
): Promise<DraftOneResult> {
  // 1. Quote (PHP → PHP, BALANCE payout).
  let quote: WiseQuote;
  try {
    quote = await api.createQuote(profileId, amountPhp);
  } catch (e) {
    return { paymentId, status: 'failed', error: `quote: ${String(e)}` };
  }

  // 2. Transfer (references an EXISTING recipient by id; no bank details here).
  let transfer: { id: number };
  try {
    transfer = await api.createTransfer(recipientId, quote.id);
  } catch (e) {
    return { paymentId, status: 'failed', error: classifyDraftError('transfer: ', e) };
  }

  // IMPORTANT: we stop here. No POST .../payments. Money has NOT moved.
  return {
    paymentId,
    transferId: transfer.id,
    fxRate: quote.rate,
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
export async function serviceDraft(
  db: Db,
  paymentIds: string[],
  api: WiseApi = realWiseApi,
): Promise<ServiceDraftResult> {
  const profileId = await api.getBusinessProfileId();
  const rows = await fetchDraftPayments(db, paymentIds);
  const results: DraftOneResult[] = [];

  for (const row of rows) {
    const triage = triageDraftRow(row);
    if ('skip' in triage) {
      results.push({ paymentId: row.id, status: 'skipped', error: triage.skip });
      continue;
    }

    const res = await draftOne(api, profileId, row.id, triage.recipientId, triage.amountPhp);
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
  api: WiseApi = realWiseApi,
): Promise<ServiceBatchResult> {
  const profileId = await api.getBusinessProfileId();
  const overrides = new Map(items.map((i) => [i.paymentId, i]));
  const rows = await fetchDraftPayments(
    db,
    items.map((i) => i.paymentId),
  );
  const eligible = rows.filter((r) => !('skip' in triageDraftRow(r, overrides.get(r.id))));

  if (eligible.length === 0)
    throw new Error('No eligible payments (already drafted, or missing recipient or amount)');

  // 1. Create the batch group.
  const group = await api.createBatchGroup(
    profileId,
    name ?? `Payroll ${new Date().toISOString().slice(0, 10)}`,
  );

  const results: DraftOneResult[] = [];

  for (const row of rows) {
    const triage = triageDraftRow(row, overrides.get(row.id));

    if ('skip' in triage) {
      results.push({ paymentId: row.id, status: 'skipped', error: triage.skip });
      continue;
    }
    const { recipientId, amountPhp } = triage;

    try {
      // Quote, then a transfer inside the batch group.
      const quote = await api.createQuote(profileId, amountPhp);
      const t = await api.createTransfer(recipientId, quote.id, {
        profileId,
        batchGroupId: group.id,
      });

      // Write back to DB.
      await setWiseTransferIdSafe(db, row.id, String(t.id), quote.rate);
      results.push({
        paymentId: row.id,
        transferId: t.id,
        fxRate: quote.rate,
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
 * Callers: the admin "Check statuses" action (wisePoll) and the scheduled
 * /api/cron/wise-reconcile route (app-owned since 2026-08-29; the Deno edge
 * function's cron path was never scheduled in prod).
 *
 * @param onlyDrafts   Default true — restrict to status='draft' (fast + idempotent).
 * @param payPeriodId  Optional scope to a single period.
 */
export async function servicePoll(
  db: Db,
  opts: { onlyDrafts?: boolean; payPeriodId?: string } = {},
  api: WiseApi = realWiseApi,
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
      const detail = await api.getTransfer(p.wise_transfer_id);
      return detail ? { p, ok: true as const, detail } : { p, ok: false as const };
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
    const st = f.detail.status ?? '';

    if (WISE_PAID_STATES.has(st)) {
      // Use Wise's REAL sent date (or dateFunded / created as fallbacks) instead of
      // now(). Also captures the full wise_dates triple for the UI tooltip.
      const dates = f.detail.dates;
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

export interface MatchStats extends MatchTally {
  /** noRecipient + noTransfer + unpaidLink + wrongPeriod — the log line's number. */
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
 * @param refresh      ALSO re-fetch already-matched rows (to re-check dead links
 *                     and backfill wise_dates) — a superset of a plain match:
 *                     unmatched rows still get discovery in the same run.
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
  api: WiseApi = realWiseApi,
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
      ...tallyMatch([]),
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

  // 3. Pull Wise transfer history for the union window (paging in the adapter).
  const profileId = await api.getBusinessProfileId();
  const wiseTransfers = await api.listTransfers({ fromIso, toIso });

  // Everything between the Wise pull and the DB writes is the pure plan — the
  // taken set, the ambiguity breaker, the duplicate-reference guard, the
  // unlinked list all live in plan-match.ts.
  const claimed = await fetchClaimedTransferIds(db);
  const { decisions, unlinked } = await planMatchRun(
    {
      payments,
      transfers: wiseTransfers,
      claimed,
      profileId,
      windowDays,
      refresh,
      dryRun,
      nowIso: new Date().toISOString(),
    },
    api,
  );

  // Apply the planned patches — the only writes in a match run.
  const results = decisions.map((d) => d.result);
  if (!dryRun) {
    for (const [i, d] of decisions.entries()) {
      if (!d.patch) continue;
      try {
        await applyMatchPatch(db, d.result.payment_id, d.patch);
      } catch {
        results[i] = {
          payment_id: d.result.payment_id,
          worker_id: d.result.worker_id,
          outcome: 'db_write_failed',
          error: 'db write failed',
        };
      }
    }
  }

  const tally = tallyMatch(results);
  const live = filterLive(wiseTransfers).length;
  return {
    ...tally,
    unmatched: tally.noRecipient + tally.noTransfer + tally.unpaidLink + tally.wrongPeriod,
    wiseTransfersPulled: wiseTransfers.length,
    wiseTransfersLive: live,
    wiseTransfersCancelled: wiseTransfers.length - live,
    window: { from: fromIso, to: toIso, days: windowDays },
    mode: refresh ? 'refresh' : 'match',
    results,
    unlinked,
  };
}

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
  api: WiseApi = realWiseApi,
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

  const detail = await api.getTransfer(transferId);
  if (!detail) throw new Error(`Wise transfer ${transferId} was not found on this account.`);
  const status = detail.status;
  if (status === 'cancelled') {
    throw new Error(`Wise transfer ${transferId} is cancelled — it never paid anyone.`);
  }
  if (status && !WISE_PAID_STATES.has(status)) {
    throw new Error(
      `Wise transfer ${transferId} is ${status} — it hasn't paid anyone yet, so it can't be the transfer that paid this row.`,
    );
  }

  const dates = detail.dates;
  const sentIso = bestSentDate(dates);
  const wiseAmount = detail.targetValue ?? 0;

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
  api: WiseApi = realWiseApi,
): Promise<UnlinkTransferResult> {
  const transferId = payment.wise_transfer_id;
  if (!transferId) throw new Error('This payment is not linked to a Wise transfer.');

  // A transfer we can't read is one we can't call live, so it can't block the
  // unlink — but an in-flight draft we CAN read must.
  const detail = await api.getTransfer(transferId);
  const status = detail?.status ?? null;
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

export async function serviceStatus(
  transferIds: (string | number)[],
  api: WiseApi = realWiseApi,
): Promise<WiseTransferStatus[]> {
  return mapLimit(transferIds, 8, async (id) => {
    try {
      const t = await api.getTransfer(id);
      if (!t) return { id, status: null, error: 'fetch failed' };
      return { id, status: t.status };
    } catch {
      return { id, status: null, error: 'fetch failed' };
    }
  });
}

export async function serviceRates(
  transferIds: (string | number)[],
  api: WiseApi = realWiseApi,
): Promise<WiseRateRow[]> {
  return mapLimit(transferIds, 8, async (id) => {
    const failed = {
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
    try {
      const t = await api.getTransfer(id);
      if (!t) return failed;
      return {
        id,
        rate: t.rate,
        status: t.status,
        sourceCurrency: t.sourceCurrency,
        targetCurrency: t.targetCurrency,
        sourceValue: t.sourceValue,
        targetValue: t.targetValue,
        targetAccount: t.targetAccount == null ? null : Number(t.targetAccount),
        reference: t.reference,
        created: t.created,
      };
    } catch {
      return failed;
    }
  });
}

export async function serviceRecipients(
  profileId?: number,
  api: WiseApi = realWiseApi,
): Promise<{
  profileId: number;
  recipients: WiseRecipient[];
}> {
  const pid = profileId ?? (await api.getBusinessProfileId());
  return { profileId: pid, recipients: await api.listRecipients(pid) };
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
  api: WiseApi = realWiseApi,
): Promise<{ uuid: string; recipientId: number; name: string }[]> {
  const pid = profileId ?? (await api.getBusinessProfileId());
  const contacts = await api.listContacts(pid, term);
  return contacts.filter((c) => /-/.test(c.uuid)); // keep real UUID contacts only (batch-CSV key)
}

/**
 * Build an admin-facing reason for a recipient that came back missing,
 * distinguishing a stale/deleted id from a systemic credential/environment
 * problem (when the token sees zero recipients). Call this ONLY on the miss
 * path — it performs one extra recipient-list request.
 */
export async function explainMissingRecipient(
  recipientId: number,
  api: WiseApi = realWiseApi,
): Promise<string> {
  try {
    const { recipients } = await serviceRecipients(undefined, api);
    return missingRecipientReason(recipientId, recipients.length);
  } catch (e) {
    return (
      `Recipient ${recipientId} not found, and the Wise recipient list could not be loaded ` +
      `(${e instanceof Error ? e.message : String(e)}). Check WISE_API_TOKEN and connectivity.`
    );
  }
}

export async function serviceGetRecipient(
  recipientId: number,
  api: WiseApi = realWiseApi,
): Promise<WiseRecipient | null> {
  return api.getRecipient(recipientId);
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
  api: WiseApi = realWiseApi,
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

  const all = await api.listTransfers({ fromIso, toIso });
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
  api: WiseApi = realWiseApi,
): Promise<AttributionResult> {
  if (!payment.wise_transfer_id) {
    throw new Error('Link the Wise transfer first — there is no variance until there is a link.');
  }

  const detail = await api.getTransfer(payment.wise_transfer_id);
  if (!detail) {
    throw new Error(`Wise transfer ${payment.wise_transfer_id} was not found on this account.`);
  }
  const wiseAmount = detail.targetValue ?? 0;
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
  api: WiseApi = realWiseApi,
): Promise<CancelTransferResult> {
  const transferId = payment.wise_transfer_id;
  if (!transferId) throw new Error('This payment is not linked to a Wise transfer.');

  const detail = await api.getTransfer(transferId);
  if (!detail) throw new Error(`Wise transfer ${transferId} was not found on this account.`);
  const previousStatus = detail.status ?? '';
  if (WISE_PAID_STATES.has(previousStatus)) {
    throw new Error(
      `Transfer ${transferId} is ${previousStatus} — that money has already gone out. Nothing to cancel.`,
    );
  }
  if (!isCancellable(previousStatus)) {
    throw new Error(`Transfer ${transferId} is ${previousStatus} — it cannot be cancelled.`);
  }

  const { status } = await api.cancelTransfer(transferId);

  await appendPaymentNote(
    db,
    payment.id,
    `Cancelled draft #${transferId}${reason ? `: ${reason}` : ''}`,
    payment.note,
  );

  return { transferId, previousStatus, status };
}
