/**
 * Pure backfill matcher for Wise transfers.
 *
 * NO network, NO DB, NO server-only imports — all rules are exercised by unit
 * tests in tests/lib/wise/matcher.test.ts.
 *
 * Ported faithfully from the legacy edge function (wise-payouts/index.ts ~409-916).
 * Every comment that names a real incident (2026-05-28, 2026-05-29 batch) is
 * preserved so future reviewers have the same context the legacy fn had.
 */

import { majorToMinor } from '@/lib/money';
import type {
  MatchDecision,
  MatcherPayment,
  MatchResult,
  OrphanCandidate,
  PaymentPatch,
  WiseDates,
  WiseTransfer,
} from './types';
import { WISE_PAID_STATES } from './types';

// ─── constants ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * ₱1.00 tolerance in integer centavos (100).
 *
 * Wise batch uploads often round to the nearest peso — a true match for a
 * calculated ₱31,229.70 might be sent as ₱31,230 without any real override
 * happening. Differences bigger than ₱1 are treated as real variances.
 * Uses majorToMinor so the comparison is always integer-centavos (no float drift).
 */
const TOLERANCE_CENTAVOS = majorToMinor(1.0); // 100

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Anchor epoch ms for the match window: prefer paid_at — the app's own record
 * of when the batch was actually sent — over the period's scheduled pay_date
 * (a batch paid two weeks late would otherwise put every real transfer outside
 * the ±window and come back no_wise_transfer_in_window). Falls back to
 * pay_date, then period_end, then now.
 */
function payDateMs(p: MatcherPayment): number {
  const d = p.paid_at ?? p.pay_periods?.pay_date ?? p.pay_periods?.period_end;
  return d ? new Date(d).getTime() : Date.now();
}

/** Extract the transfer's created epoch ms. */
function transferCreatedMs(t: WiseTransfer): number {
  const s = t.created ?? t.createdAt ?? null;
  return s ? new Date(s).getTime() : 0;
}

/** Amount in centavos from a transfer row (targetValue preferred, fallback targetAmount). */
function transferCentavos(t: WiseTransfer): number {
  return majorToMinor(Number(t.targetValue ?? t.targetAmount ?? 0));
}

/** Amount in centavos from a payment row. */
function paymentCentavos(p: MatcherPayment): number {
  return majorToMinor(Number(p.net_php ?? 0));
}

/** Absolute centavo delta between payment and transfer. */
function centavoDelta(p: MatcherPayment, t: WiseTransfer): number {
  return Math.abs(transferCentavos(t) - paymentCentavos(p));
}

/** True when the transfer amount is within ±₱1.00 of the payment amount. */
function isWithinTolerance(p: MatcherPayment, t: WiseTransfer): boolean {
  return centavoDelta(p, t) <= TOLERANCE_CENTAVOS;
}

/** True when the transfer was created within ±windowDays of the payment's pay_date. */
function isInWindow(t: WiseTransfer, payTs: number, windowDays: number): boolean {
  const tt = transferCreatedMs(t);
  return Math.abs(tt - payTs) <= windowDays * DAY_MS;
}

/**
 * Extract the distinct lookup keys for a worker's Wise recipients.
 *
 * Priority order: current numeric id → UUID → every historical id in the
 * wise_recipients JSON array. Historical periods may have been paid via an
 * OLD recipient id — without unioning them, those historical matches return
 * "no_wise_transfer" even though Wise still has the transfer.
 */
function recipientKeys(p: MatcherPayment): string[] {
  const numId = String(p.workers?.wise_recipient_id ?? '').trim();
  const uuidId = String(p.workers?.wise_recipient_uuid ?? '').trim();
  const raw = p.workers?.wise_recipients;
  const historicIds: string[] = (Array.isArray(raw) ? raw : [])
    .map((x: unknown) => {
      if (x !== null && typeof x === 'object' && 'id' in x) {
        return String((x as Record<string, unknown>).id ?? '').trim();
      }
      return '';
    })
    .filter((s) => s !== '');

  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (k: string): void => {
    if (k && !seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  };
  push(numId);
  push(uuidId);
  for (const k of historicIds) push(k);
  return keys;
}

/**
 * Build a map from recipient key → transfer[] from a de-cancelled transfer list.
 * Indexes by both numeric targetAccount AND recipientId (UUID) to survive a
 * future Wise API format shift.
 */
export function buildRecipientIndex(transfers: WiseTransfer[]): Map<string, WiseTransfer[]> {
  const map = new Map<string, WiseTransfer[]>();
  for (const t of transfers) {
    const numKey = String(t.targetAccount ?? '').trim();
    if (numKey) {
      const arr = map.get(numKey) ?? [];
      arr.push(t);
      map.set(numKey, arr);
    }
    const uuidKey = String(t.recipientId ?? '').trim();
    if (uuidKey && uuidKey !== numKey) {
      const arr = map.get(uuidKey) ?? [];
      arr.push(t);
      map.set(uuidKey, arr);
    }
  }
  return map;
}

/** Build a map from transfer id (string) → transfer. */
export function buildTransferIdIndex(transfers: WiseTransfer[]): Map<string, WiseTransfer> {
  const map = new Map<string, WiseTransfer>();
  for (const t of transfers) {
    if (t.id != null) map.set(String(t.id), t);
  }
  return map;
}

/**
 * Filter out cancelled transfers BEFORE indexing.
 *
 * Wise's batch CSV upload flow creates draft "shadow" transfers in the API that
 * get cancelled when the actual funded transfer is created — leaving the history
 * with both a `cancelled` ghost AND the real `outgoing_payment_sent` transfer for
 * the same recipient+amount. Including the ghosts would make every row look
 * "ambiguous" (2 candidates per recipient).
 * Confirmed via live API probe on the May 2026 batch: 13 sent + 12 cancelled.
 */
export function filterLive(transfers: WiseTransfer[]): WiseTransfer[] {
  return transfers.filter((t) => t.status !== 'cancelled');
}

// ─── refresh fast-path ────────────────────────────────────────────────────────

/**
 * REFRESH FAST PATH: the row already has a transfer_id — look it up directly
 * in the by-id index and re-apply dates / status / variance-override.
 *
 * Skip recipient + window matching entirely so historical pay_date mismatches
 * don't hide the row's real transfer.
 *
 * @param p             Payment row with an existing wise_transfer_id.
 * @param idIndex       Index of live transfers keyed by string id.
 * @param dates         Pre-fetched WiseDates for the transfer (service layer fetches these).
 * @param nowIso        Current timestamp string.
 */
export function decideRefresh(
  p: MatcherPayment,
  idIndex: Map<string, WiseTransfer>,
  dates: WiseDates,
  nowIso: string,
): MatchDecision {
  const storedId = String(p.wise_transfer_id ?? '');
  const t = idIndex.get(storedId);
  if (!t) {
    return {
      result: {
        payment_id: p.id,
        worker_id: p.worker_id,
        outcome: 'refresh_transfer_not_in_history',
        transfer_id: storedId,
        reason: 'Stored transfer_id not found in the pulled Wise history window',
      },
    };
  }

  const dbCentavos = paymentCentavos(p);
  const wiseCentavos = transferCentavos(t);
  const exact = Math.abs(wiseCentavos - dbCentavos) <= TOLERANCE_CENTAVOS;

  const patch: PaymentPatch = { wise_dates: dates };

  const sentIso = dates.dateSent ?? dates.dateFunded ?? dates.created ?? null;
  const wiseTerminal = WISE_PAID_STATES.has(t.status);

  if (sentIso && wiseTerminal) {
    patch.paid_at = sentIso;
    patch.status = 'sent';
    patch.wise_locked_at = nowIso;
  } else if (p.status === 'sent') {
    // The row was ALREADY recorded as sent (CSV import / manual / a prior poll)
    // and we've re-found its non-cancelled transfer in Wise. Lock it even though
    // the live API status isn't terminal: some batch-uploaded transfers keep
    // reporting a non-terminal status long after the money actually went out
    // (e.g. the 2026-05-29 batch showed "in progress" though the payroll was
    // paid). We trust the recorded 'sent' here.
    patch.wise_locked_at = nowIso;
  }

  // Variance auto-override on the refresh path: always treats the existing link
  // as unambiguous, so apply the override if amount differs and we haven't
  // already overridden (don't overwrite a previous original_net_php on re-run).
  if (!exact && p.original_net_php == null) {
    patch.original_net_php = Number(p.net_php ?? 0);
    patch.net_php = Number(t.targetValue ?? t.targetAmount ?? 0);
  }

  const result: MatchResult = exact
    ? {
        payment_id: p.id,
        worker_id: p.worker_id,
        outcome: 'refreshed_clean',
        transfer_id: String(t.id),
        amount: Number(p.net_php ?? 0),
        wise_status: t.status,
        wise_dates: dates,
      }
    : {
        payment_id: p.id,
        worker_id: p.worker_id,
        outcome: 'matched_with_variance_overridden',
        transfer_id: String(t.id),
        db_amount: Number(p.net_php ?? 0),
        wise_amount: Number(t.targetValue ?? t.targetAmount ?? 0),
        delta: Number(t.targetValue ?? t.targetAmount ?? 0) - Number(p.net_php ?? 0),
        wise_status: t.status,
        wise_dates: dates,
        amount_overridden: p.original_net_php == null,
      };

  return { patch, result };
}

// ─── discovery path ───────────────────────────────────────────────────────────

/**
 * DISCOVERY PATH (first-time match): recipient + window + amount matching.
 *
 * Applies ALL legacy edge cases in order:
 *  1. No recipient keys stored → no_recipient
 *  2. No transfer in the recipient index → no_wise_transfer
 *  3. Transfer exists but outside ±windowDays → no_wise_transfer_in_window
 *  4. Exactly one within-tolerance candidate → matched_exact
 *  5. Multiple within-tolerance → closest-pay-date disambiguation → ambiguous_exact if true tie
 *  6. No within-tolerance candidate, one inWindow → unambiguous variance auto-override
 *  7. No within-tolerance candidate, multiple inWindow → ambiguous variance (no auto-override)
 *
 * @param p           Payment to match.
 * @param recipIndex  Map built by buildRecipientIndex from live (non-cancelled) transfers.
 * @param dates       WiseDates for the chosen transfer — supplied by the service layer
 *                    (which fetches the detail endpoint for each candidate).
 *                    Pass a function so the pure matcher can request dates lazily.
 * @param windowDays  Half-window in days (default 7, legacy default).
 * @param nowIso      Current ISO timestamp.
 */
export function decideMatch(
  p: MatcherPayment,
  recipIndex: Map<string, WiseTransfer[]>,
  getDates: (t: WiseTransfer) => WiseDates,
  windowDays: number,
  nowIso: string,
): MatchDecision {
  // 1. Recipient keys
  const keys = recipientKeys(p);
  if (keys.length === 0) {
    return {
      result: {
        payment_id: p.id,
        worker_id: p.worker_id,
        outcome: 'no_recipient',
        reason:
          'Worker has no wise_recipient_id, wise_recipient_uuid, or wise_recipients entries stored',
      },
    };
  }

  // 2. Union candidates across every known recipient key — dedupe by transfer id.
  const seenIds = new Set<string>();
  const candidates: WiseTransfer[] = [];
  for (const k of keys) {
    for (const t of recipIndex.get(k) ?? []) {
      const id = String(t.id ?? '');
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        candidates.push(t);
      }
    }
  }

  if (candidates.length === 0) {
    const tried = keys.length === 1 ? 'this recipient' : `${keys.length} known recipient ids`;
    return {
      result: {
        payment_id: p.id,
        worker_id: p.worker_id,
        outcome: 'no_wise_transfer',
        reason: `No Wise transfer in the union window for ${tried} (${keys.join(', ')})`,
        recipient_keys_tried: keys,
      },
    };
  }

  // 3. Per-payment date window filter.
  const payTs = payDateMs(p);
  const inWindow = candidates.filter((t) => isInWindow(t, payTs, windowDays));

  if (inWindow.length === 0) {
    const tried = keys.length === 1 ? 'this recipient' : `${keys.length} known recipient ids`;
    return {
      result: {
        payment_id: p.id,
        worker_id: p.worker_id,
        outcome: 'no_wise_transfer_in_window',
        reason: `Wise has transfers to ${tried} but none within ±${windowDays} days of pay_date`,
        recipient_keys_tried: keys,
      },
    };
  }

  // 4 + 5. Exact amount match (within ±₱1.00).
  const exact = inWindow.filter((t) => isWithinTolerance(p, t));

  if (exact.length === 1) {
    const t = exact[0] as WiseTransfer;
    const dates = getDates(t);
    const patch = buildSuccessPatch(p, t, dates, nowIso, false);
    return {
      patch,
      result: {
        payment_id: p.id,
        worker_id: p.worker_id,
        outcome: 'matched_exact',
        transfer_id: String(t.id),
        amount: Number(p.net_php ?? 0),
        wise_status: t.status,
        wise_dates: dates,
      },
    };
  }

  if (exact.length > 1) {
    // Multiple exact-amount matches — resolve by closest pay_date.
    const ranked = [...exact].sort(
      (a, b) => Math.abs(transferCreatedMs(a) - payTs) - Math.abs(transferCreatedMs(b) - payTs),
    );
    const first = ranked[0] as WiseTransfer;
    const second = ranked[1] as WiseTransfer;
    const closestMs = Math.abs(transferCreatedMs(first) - payTs);
    const runnerUpMs = Math.abs(transferCreatedMs(second) - payTs);
    // Only a true tie when the two closest are within 1 day of each other
    // relative to pay_date — that's a genuine "can't tell" case.
    const isTrueTie = Math.abs(closestMs - runnerUpMs) < DAY_MS;

    if (isTrueTie) {
      return {
        result: {
          payment_id: p.id,
          worker_id: p.worker_id,
          outcome: 'ambiguous_exact',
          reason: `${exact.length} Wise transfers match recipient + amount equally close to pay_date — can't pick automatically`,
          candidate_transfer_ids: exact.map((t) => String(t.id)),
        },
      };
    }

    // Closest-pay-date wins — treat as an exact match.
    const t = first;
    const dates = getDates(t);
    const patch = buildSuccessPatch(p, t, dates, nowIso, false);
    return {
      patch,
      result: {
        payment_id: p.id,
        worker_id: p.worker_id,
        outcome: 'matched_closest_date',
        transfer_id: String(t.id),
        amount: Number(p.net_php ?? 0),
        wise_status: t.status,
        wise_dates: dates,
        also_considered: ranked.slice(1).map((x) => String(x.id)),
      },
    };
  }

  // 6 + 7. No exact amount match — amount variance path.
  // Sort inWindow by closest amount to payment.
  const dbCentavos = paymentCentavos(p);
  const ranked = [...inWindow].sort(
    (a, b) =>
      Math.abs(transferCentavos(a) - dbCentavos) - Math.abs(transferCentavos(b) - dbCentavos),
  );
  const t = ranked[0] as WiseTransfer;
  const wiseAmt = Number(t.targetValue ?? t.targetAmount ?? 0);
  const isUnambiguous = inWindow.length === 1;
  const dates = getDates(t);

  const patch: PaymentPatch = {
    wise_transfer_id: String(t.id),
    wise_dates: dates,
  };

  // ONLY auto-override the amount when this is unambiguous AND the row doesn't
  // already have an override stored (don't overwrite a previous original_net_php
  // on a re-run).
  if (isUnambiguous && p.original_net_php == null) {
    patch.original_net_php = Number(p.net_php ?? 0);
    patch.net_php = wiseAmt;
  }

  const sentIso = dates.dateSent ?? dates.dateFunded ?? dates.created ?? null;
  if (sentIso && WISE_PAID_STATES.has(t.status)) {
    patch.paid_at = sentIso;
    patch.status = 'sent';
    patch.wise_locked_at = nowIso;
  }

  return {
    patch,
    result: {
      payment_id: p.id,
      worker_id: p.worker_id,
      outcome: isUnambiguous ? 'matched_with_variance_overridden' : 'matched_with_variance',
      transfer_id: String(t.id),
      db_amount: Number(p.net_php ?? 0),
      wise_amount: wiseAmt,
      delta: wiseAmt - Number(p.net_php ?? 0),
      wise_status: t.status,
      wise_dates: dates,
      other_candidates: ranked.length - 1,
      amount_overridden: isUnambiguous && p.original_net_php == null,
    },
  };
}

// ─── orphan diagnostics ───────────────────────────────────────────────────────

/**
 * Build orphan-transfer suggestions for unmatched payment results.
 *
 * An "orphan" is a live transfer that wasn't claimed by any DB row. A single
 * orphan that fits exactly one unmatched payment is a confident candidate for
 * a one-click "Link this recipient" action. An orphan that fits multiple
 * payments is flagged ambiguous so the UI forces an explicit pick.
 *
 * Mutates the result objects in place (same pattern as the legacy function).
 */
export function annotateOrphans(
  allResults: MatchResult[],
  allPayments: MatcherPayment[],
  liveTransfers: WiseTransfer[],
  windowDays: number,
): void {
  const claimedIds = new Set<string>(
    allResults
      .filter((r): r is Extract<MatchResult, { transfer_id: string }> => 'transfer_id' in r)
      .map((r) => String(r.transfer_id)),
  );

  const orphans = liveTransfers.filter((t) => !claimedIds.has(String(t.id)));
  if (orphans.length === 0) return;

  const paymentById = new Map<string, MatcherPayment>();
  for (const p of allPayments) paymentById.set(p.id, p);

  const unmatchedResults = allResults.filter(
    (r) => r.outcome === 'no_wise_transfer' || r.outcome === 'no_wise_transfer_in_window',
  ) as Extract<MatchResult, { outcome: 'no_wise_transfer' | 'no_wise_transfer_in_window' }>[];

  const fitsPayment = (t: WiseTransfer, p: MatcherPayment): boolean => {
    const tt = transferCreatedMs(t);
    if (Math.abs(tt - payDateMs(p)) > windowDays * DAY_MS) return false;
    return isWithinTolerance(p, t);
  };

  // Count how many unmatched payments each orphan fits (for ambiguity flag).
  const fitCount = new Map<string, number>();
  for (const t of orphans) {
    let n = 0;
    for (const r of unmatchedResults) {
      const p = paymentById.get(r.payment_id);
      if (p && fitsPayment(t, p)) n++;
    }
    fitCount.set(String(t.id), n);
  }

  for (const r of unmatchedResults) {
    const p = paymentById.get(r.payment_id);
    if (!p) continue;
    const fits = orphans.filter((t) => fitsPayment(t, p)).slice(0, 5);
    if (fits.length === 0) continue;
    r.candidate_orphan_transfers = fits.map((t): OrphanCandidate => {
      const shared = fitCount.get(String(t.id)) ?? 1;
      return {
        transfer_id: String(t.id),
        target_account: String(t.targetAccount ?? ''),
        target_value: Number(t.targetValue ?? t.targetAmount ?? 0),
        created: t.created ?? t.createdAt ?? null,
        wise_status: t.status ?? null,
        shared_with_n_payments: shared,
        ambiguous: shared > 1,
      };
    });
  }
}

// ─── private helpers ──────────────────────────────────────────────────────────

function buildSuccessPatch(
  _p: MatcherPayment,
  t: WiseTransfer,
  dates: WiseDates,
  nowIso: string,
  _refresh: boolean,
): PaymentPatch {
  const patch: PaymentPatch = {
    wise_transfer_id: String(t.id),
    wise_dates: dates,
  };
  const sentIso = dates.dateSent ?? dates.dateFunded ?? dates.created ?? null;
  if (sentIso && WISE_PAID_STATES.has(t.status)) {
    patch.paid_at = sentIso;
    patch.status = 'sent';
    patch.wise_locked_at = nowIso;
  }
  return patch;
}
