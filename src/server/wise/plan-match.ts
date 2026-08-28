/**
 * The pure core of a backfill-match run: decide, never touch the DB.
 *
 * serviceMatch (service.ts) does the IO — fetch the candidate payments, pull
 * the Wise history, apply the patches this plan proposes. Everything between
 * those edges lives here, keyed only on the inputs and the WiseApi seam, so
 * every matching rule is testable with fakes and no Supabase.
 *
 * See src/lib/wise/matcher.ts for the per-payment matching logic; this module
 * owns the run-level rules — the taken set, the ambiguity breaker, the
 * duplicate-reference guard, and the unlinked list the operator acts on.
 */

import 'server-only';
import type { MatchPayment } from '@/db/queries/wise';
import { fullName } from '@/lib/names';
import { bestSentDate, wiseDatesFromListRow } from '@/lib/wise/dates';
import {
  annotateOrphans,
  buildRecipientIndex,
  buildTransferIdIndex,
  decideMatch,
  decideRefresh,
  filterLive,
} from '@/lib/wise/matcher';
import { type PeriodWindow, referenceMatchesPeriod } from '@/lib/wise/reference';
import type {
  MatchDecision,
  MatcherPayment,
  OrphanCandidate,
  UnlinkedPayment,
  WiseDates,
  WiseTransfer,
} from '@/lib/wise/types';
import { WISE_PAID_STATES } from '@/lib/wise/types';
import type { WiseApi } from './api';

/** Detail calls spent breaking one ambiguous row. Enough for a same-amount
 *  cluster (the biggest seen is 5), small enough to stay cheap. */
const MAX_REFERENCE_PROBES = 6;

/** The period bounds a reference is judged against. */
const periodWindow = (p: MatcherPayment): PeriodWindow => ({
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

// ─── concurrency helper ────────────────────────────────────────────────────────

export async function mapLimit<T, R>(
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

// ─── date helpers (network via the WiseApi seam) ──────────────────────────────

/**
 * Dates AND `details.reference` in one call. The reference is only returned by
 * the detail endpoint, and this path already pays for that call — so the
 * strongest signal available about which period a transfer paid costs nothing
 * extra to read. See lib/wise/reference.ts.
 */
async function fetchWiseDetail(
  api: WiseApi,
  listRow: WiseTransfer,
): Promise<{ dates: WiseDates; reference: string | null }> {
  const dates = wiseDatesFromListRow(listRow);
  try {
    const detail = await api.getTransfer(listRow.id);
    if (detail) {
      dates.dateFunded = detail.dates.dateFunded;
      dates.dateSent = detail.dates.dateSent;
      if (!dates.created) dates.created = detail.dates.created;
      return { dates, reference: detail.reference };
    }
  } catch {
    // best-effort — keep created at minimum
  }
  return { dates, reference: null };
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

// ─── the plan ─────────────────────────────────────────────────────────────────

/** A MatchPayment reshaped for the pure matcher — one conversion feeds both the
 *  per-row decisions and the orphan sweep. */
const toMatcherPayment = (p: MatchPayment): MatcherPayment => ({
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
  // Recipient names give the orphan sweep its second axis (amount alone can't
  // tell two contractors on a round ₱10,000 apart).
  worker_name: p.workers
    ? fullName({
        firstName: p.workers.first_name,
        middleName: p.workers.middle_name,
        lastName: p.workers.last_name,
      })
    : null,
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
});

export interface MatchRunInput {
  payments: MatchPayment[];
  /** The full pulled Wise list, cancelled ghosts INCLUDED — a row linked to one
   *  has to be able to find it by id, or its dead link reports as "not in the
   *  history window" and looks like a paging problem instead of the ghost it is. */
  transfers: WiseTransfer[];
  /** Transfer ids already stored on ANY payments row. One transfer pays one
   *  row, so anything a payment already holds is off the table before the
   *  matcher ever sees it — the discovery path is what put 36 transfers on two
   *  rows each. */
  claimed: ReadonlySet<string>;
  profileId: number;
  windowDays: number;
  refresh: boolean;
  dryRun: boolean;
  nowIso: string;
}

export interface MatchPlan {
  /** One decision per payment, in payment order. `result.payment_id` names the
   *  row; `patch` is the write serviceMatch applies (absent in refusals). */
  decisions: MatchDecision[];
  /** Rows the run leaves without a transfer that paid, each with the transfers
   *  that could be it. */
  unlinked: UnlinkedPayment[];
}

/**
 * Decide a whole match run: which transfer pays which row, what to write, and
 * what to show the operator. Reads Wise via the seam (detail probes, recipient
 * names), never the DB, and writes nothing anywhere.
 */
export async function planMatchRun(input: MatchRunInput, api: WiseApi): Promise<MatchPlan> {
  const { payments, transfers, claimed, profileId, windowDays, refresh, dryRun, nowIso } = input;

  const liveTransfers = filterLive(transfers);
  const unclaimed = liveTransfers.filter((t) => !claimed.has(String(t.id)));
  const recipIndex = buildRecipientIndex(unclaimed);
  const idIndex = buildTransferIdIndex(transfers);

  const matcherPayments = payments.map(toMatcherPayment);
  const decisions: MatchDecision[] = [];
  /** Payments this run leaves carrying a transfer that paid. */
  const linkedPaymentIds = new Set<string>();
  /** dry-run only: payment id → the transfer a real run would have linked. */
  const proposed = new Map<string, string>();
  /** Transfers this run has already handed out — one transfer pays one row. */
  const taken = new Set<string>();

  for (const mp of matcherPayments) {
    // DISCOVERY PATH: fetch dates lazily only for the winning transfer.
    const discover = async (m: MatcherPayment): Promise<MatchDecision> => {
      const getDates = (t: WiseTransfer): WiseDates => {
        // For the sync pure matcher call, return list-row dates (no network).
        // The detail is re-fetched asynchronously below.
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
          const { reference } = await fetchWiseDetail(api, t);
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
          const { dates: realDates, reference } = await fetchWiseDetail(api, t);

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
    if (refresh && mp.wise_transfer_id) {
      // REFRESH FAST PATH: fetch detail dates from Wise for the stored transfer.
      const storedT = idIndex.get(String(mp.wise_transfer_id));
      const dates: WiseDates = storedT
        ? (await fetchWiseDetail(api, storedT)).dates
        : { created: null, dateFunded: null, dateSent: null };
      decision = decideRefresh(mp, idIndex, dates, nowIso);

      // The stored transfer is cancelled/refunded — it paid nobody, so the row is
      // effectively unlinked and the transfer that DID pay it is still sitting
      // unclaimed. Re-run discovery here rather than making the operator unlink by
      // hand first. An unfunded draft is left alone deliberately: it is still live
      // in Wise, and orphaning it is the RP-09 double-pay route.
      // WRITE RUNS ONLY: a dry run keeps the dead-link warning visible (the orphan
      // sweep suggests the replacement below) — adopting the relink here made a
      // ghost-linked row read as clean in the read-only reconcile view.
      if (!dryRun && decision.result.outcome === 'refresh_transfer_dead') {
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
    // And a dry run WRITES nothing, so its proposals leave the row unlinked too —
    // they stay in the list, carrying the proposed transfer as the candidate.
    const deadLink =
      result.outcome === 'refresh_transfer_dead' || result.outcome === 'refresh_transfer_unfunded';
    if ((!dryRun && patch?.wise_transfer_id) || (mp.wise_transfer_id && !deadLink)) {
      linkedPaymentIds.add(mp.id);
    }
    if (dryRun && patch?.wise_transfer_id) proposed.set(mp.id, patch.wise_transfer_id);
    // Claim it for the rest of the run — in a dry run too, or the read-only view
    // would offer one transfer to two rows and both would look linkable.
    if (patch?.wise_transfer_id) taken.add(patch.wise_transfer_id);

    decisions.push(decision);
  }

  // Orphan-transfer diagnostics: annotate unmatched results with candidate
  // orphan transfers that weren't claimed by any DB row.
  const results = decisions.map((d) => d.result);

  // Recipient names give the sweep its second axis (amount alone can't tell two
  // contractors on a round ₱10,000 apart). One extra API call, and only when a
  // row actually needs the fallback.
  const needsFallback = results.some(
    (r) =>
      r.outcome === 'no_wise_transfer' ||
      r.outcome === 'no_wise_transfer_in_window' ||
      r.outcome === 'no_recipient',
  );
  let recipientNames: Map<string, string> | undefined;
  if (needsFallback) {
    try {
      const recipients = await api.listRecipients(profileId);
      const names = new Map(recipients.map((r) => [String(r.id), r.name] as [string, string]));
      // ponytail: one GET per since-deleted recipient (9 across all of 2024–2026),
      // so no caching or paging. Batch it if the recipient list ever churns hard.
      const extra = await mapLimit(unknownTargetAccounts(unclaimed, names), 8, (id) =>
        api.getRecipient(Number(id)).catch(() => null),
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
  annotateOrphans(results, matcherPayments, unclaimed, windowDays, recipientNames);

  const paymentById = new Map(matcherPayments.map((p) => [p.id, p]));

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

  const unlinked: UnlinkedPayment[] = results
    .filter((r) => !linkedPaymentIds.has(r.payment_id))
    .map((r) => ({
      paymentId: r.payment_id,
      workerName: paymentById.get(r.payment_id)?.worker_name ?? '',
      netPhp: Number(paymentById.get(r.payment_id)?.net_php ?? 0),
      outcome: r.outcome,
      reason: 'reason' in r ? r.reason : 'error' in r ? r.error : 'Not linked to a Wise transfer',
      candidates:
        ('candidate_orphan_transfers' in r ? r.candidate_orphan_transfers : undefined) ??
        proposedCandidate(r.payment_id),
    }))
    // Rows we can actually offer a candidate for come first.
    .sort((a, b) => b.candidates.length - a.candidates.length);

  return { decisions, unlinked };
}
