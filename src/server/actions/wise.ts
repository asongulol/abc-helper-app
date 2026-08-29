'use server';

/**
 * Wise payout actions — CONTRACT FILE (implemented).
 *
 * Money movement is DRAFT-ONLY (ADR-0007 / guardrails): these actions create
 * quotes and draft transfers, reconcile, and look things up. They NEVER fund.
 * The guardrail scanner (scripts/guardrails.mjs) enforces this at build time.
 *
 * Auth gates (ported from the legacy in-function gate):
 *   wiseDraft / wiseBatch  → OWNER only
 *   wisePullRecipientIds   → any admin to PREVIEW, OWNER to link (RP-56 — a link
 *                            decides where that contractor's pay lands)
 *   wisePoll  / wiseMatch  → any admin
 *     (the cron path — x-cron-secret — stays in the deployed Deno edge function
 *      supabase/functions/wise-payouts/index.ts; this action covers the
 *      on-demand admin-triggered path only)
 *   lookups (wiseStatus, wiseRecipients, wiseGetRecipient,
 *            wiseFindTransfersByRecipient) → any admin
 */

import { revalidatePath } from 'next/cache';
import { createServiceClient } from '@/db/clients/service';
import {
  ATTRIBUTION_ACTION,
  ATTRIBUTION_UNDO_ACTION,
  lastAttribution,
  paymentsWithAttribution,
} from '@/db/queries/audit';
import { fetchPeriodStatesForPayments, unpayablePeriodReason } from '@/db/queries/payroll';
import { fetchPeriodPayments } from '@/db/queries/wise';
import { type DraftPaymentRow, foreignRecipientRows, resolveDraftRow } from '@/lib/wise/draft-row';
import type { MatchOutcomeReport } from '@/lib/wise/match-summary';
import { type PullRecipientRow, planRecipientMatches } from '@/lib/wise/recipient-match';
import type { OrphanCandidate, UnlinkedPayment } from '@/lib/wise/types';
import { logEvent } from '@/server/audit';
import { requireAdmin, requireOwner } from '@/server/auth/admin';
import type { AttributionRecord, AttributionTarget } from '@/server/wise/attribution';
import {
  type AttributionPayment,
  type AttributionResult,
  type CancelTransferResult,
  explainMissingRecipient,
  type LinkTransferResult,
  serviceAttributeVariance,
  serviceBatch,
  serviceCancelTransfer,
  serviceDraft,
  serviceFindTransfersByRecipient,
  serviceGetRecipient,
  serviceLinkTransfer,
  serviceMatch,
  servicePoll,
  serviceRecipients,
  serviceStatus,
  serviceUndoAttribution,
  serviceUnlinkTransfer,
  type UnlinkTransferResult,
} from '@/server/wise/service';
import {
  WiseAttributeSchema,
  type WiseBatchItem,
  WiseBatchSchema,
  WiseCancelTransferSchema,
  WiseDraftSchema,
  WiseFindTransfersSchema,
  WiseGetRecipientSchema,
  WiseLinkTransferSchema,
  WiseMatchSchema,
  WiseStatusSchema,
  WiseUndoAttributionSchema,
  WiseUnlinkTransferSchema,
} from '@/types/schemas/wise';

export type WiseActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface DraftResult {
  paymentId: string;
  transferId?: number;
  fxRate?: number;
  error?: string;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function ok<T>(data: T): WiseActionResult<T> {
  return { ok: true, data };
}

function fail<T>(error: unknown): WiseActionResult<T> {
  const msg = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return { ok: false, error: msg };
}

/**
 * RP-52: "you can only pay a locked run" was enforced only by `process/page.tsx`
 * refusing to render. These are HTTP endpoints — a call carrying open-period
 * payment ids drafts REAL transfers for amounts the next recalculate changes,
 * and RP-10 then refuses to unlock the period because the draft exists. Same
 * gate the mark-paid actions use.
 */
async function unpayableDraftReason(
  db: ReturnType<typeof createServiceClient>,
  paymentIds: string[],
): Promise<string | null> {
  return unpayablePeriodReason(
    await fetchPeriodStatesForPayments(db, paymentIds),
    'drafted into Wise',
  );
}

// ─── OWNER-only staging actions ───────────────────────────────────────────────

/**
 * OWNER-only: create a quote + draft transfer per payment. NO funding, ever.
 *
 * Writes wise_transfer_id + fx_rate back to each payment row on success.
 */
export async function wiseDraft(paymentIds: string[]): Promise<WiseActionResult<DraftResult[]>> {
  try {
    await requireOwner();
    const parsed = WiseDraftSchema.safeParse({ paymentIds });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');

    const db = createServiceClient();
    const unpayable = await unpayableDraftReason(db, parsed.data.paymentIds);
    if (unpayable) return fail(unpayable);

    const { results } = await serviceDraft(db, parsed.data.paymentIds);

    void logEvent({
      action: 'wise_draft',
      entity: 'payments',
      detail: {
        count: results.length,
        drafted: results.filter((r) => r.status === 'drafted').length,
      },
    });

    return ok(
      results.map((r) => ({
        paymentId: r.paymentId,
        ...(r.transferId !== undefined ? { transferId: r.transferId } : {}),
        ...(r.fxRate !== undefined ? { fxRate: r.fxRate } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
      })),
    );
  } catch (e) {
    return fail(e);
  }
}

/**
 * OWNER-only: draft transfers inside a Wise batch group. NO funding, ever.
 *
 * The owner reviews, completes, and funds the batch group in the Wise UI.
 */
export async function wiseBatch(
  items: WiseBatchItem[],
  name?: string,
): Promise<WiseActionResult<{ batchGroupId: string; results: DraftResult[] }>> {
  try {
    await requireOwner();
    const parsed = WiseBatchSchema.safeParse({ items, name });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');

    const db = createServiceClient();
    const batchItems = parsed.data.items;

    const unpayable = await unpayableDraftReason(
      db,
      batchItems.map((i) => i.paymentId),
    );
    if (unpayable) return fail(unpayable);

    // RP-54: the per-row overrides are client input. Load each payment's worker
    // identity BEFORE drafting so (a) a recipient the worker doesn't own is
    // refused — it would pay their net into someone else's account, and the
    // matcher would still call it reconciled — and (b) the audit entry can carry
    // the drafted amount, which net_php never records.
    const { data: rowData, error: rowErr } = await db
      .from('payments')
      .select('id, net_php, workers(wise_recipient_id, wise_recipients, first_name, last_name)')
      .in(
        'id',
        batchItems.map((i) => i.paymentId),
      );
    if (rowErr) return fail(rowErr.message);
    const rows = (rowData ?? []) as DraftPaymentRow[];

    const foreign = foreignRecipientRows(batchItems, rows);
    if (foreign.length > 0) {
      const f = foreign[0] as { recipientId: number; name: string };
      return fail(
        `Recipient #${f.recipientId} is not on ${f.name}'s profile` +
          (foreign.length > 1 ? ` (and ${foreign.length - 1} more row(s))` : '') +
          '. Add it on the contractor profile first.',
      );
    }

    const { batchGroupId, results } = await serviceBatch(db, batchItems, parsed.data.name);

    const byId = new Map(rows.map((r) => [r.id, r]));
    void logEvent({
      action: 'wise_batch',
      entity: 'payments',
      detail: {
        batchGroupId,
        count: results.length,
        drafted: results.filter((r) => r.status === 'drafted').length,
        // Per-row trail: what was actually drafted vs. the locked net it came from.
        rows: batchItems.map((i) => {
          const row = byId.get(i.paymentId);
          const { recipientId, amountPhp } = resolveDraftRow(row ?? { net_php: null }, i);
          return {
            paymentId: i.paymentId,
            amountPhp,
            recipientId,
            netPhp: row?.net_php ?? null,
          };
        }),
      },
    });

    return ok({
      batchGroupId,
      results: results.map((r) => ({
        paymentId: r.paymentId,
        ...(r.transferId !== undefined ? { transferId: r.transferId } : {}),
        ...(r.fxRate !== undefined ? { fxRate: r.fxRate } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
      })),
    });
  } catch (e) {
    return fail(e);
  }
}

// ─── admin reconcile actions ──────────────────────────────────────────────────

/**
 * Admin: server-side reconcile — flip payments to 'sent' on terminal Wise
 * success. Idempotent. Safe to call repeatedly.
 *
 * The scheduled path is /api/cron/wise-reconcile (same servicePoll underneath).
 * This covers the on-demand admin-triggered reconcile path.
 */
export async function wisePoll(): Promise<WiseActionResult<{ updated: number; checked: number }>> {
  try {
    await requireAdmin();
    const db = createServiceClient();
    const result = await servicePoll(db);
    return ok({ updated: result.markedPaid, checked: result.checked });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Admin: backfill matcher for payments missing a wise_transfer_id.
 *
 * The args are intentionally extended vs. the legacy stub (periodStart/End were
 * placeholders; the service layer uses payPeriodId + windowDays + refresh).
 * The legacy stub's { periodStart?, periodEnd? } shape is preserved for
 * call-site compatibility — callers that pass nothing still work.
 */
export async function wiseMatch(_args: {
  periodStart?: string;
  periodEnd?: string;
  payPeriodId?: string;
  windowDays?: number;
  refresh?: boolean;
}): Promise<WiseActionResult<MatchOutcomeReport>> {
  try {
    await requireAdmin();
    const parsed = WiseMatchSchema.safeParse({
      payPeriodId: _args.payPeriodId,
      windowDays: _args.windowDays,
      refresh: _args.refresh,
    });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');

    const db = createServiceClient();
    const result = await serviceMatch(db, parsed.data);

    // Log override events separately so the audit trail tracks each reconcile.
    const overrides = result.results.filter(
      (r) => r.outcome === 'matched_with_variance_overridden',
    );
    if (overrides.length > 0) {
      void logEvent({
        action: 'wise_match_override',
        entity: 'payments',
        detail: {
          count: overrides.length,
          paymentIds: overrides.map((r) => r.payment_id),
        },
      });
    }

    void logEvent({
      action: 'wise_match',
      entity: 'payments',
      detail: {
        scanned: result.scanned,
        matched: result.matched,
        variances: result.variances,
        ambiguous: result.ambiguous,
        unmatched: result.unmatched,
        mode: result.mode,
      },
    });

    // The whole tally, not just the two outcomes the UI used to show — counted
    // once in tallyMatch (MatchStats extends MatchTally). See matchSummary.
    const { scanned, matched, variances, ambiguous, noRecipient, noTransfer } = result;
    const { dbWriteFailed, unpaidLink, wrongPeriod } = result;
    return ok({
      unlinked: result.unlinked,
      scanned,
      matched,
      variances,
      ambiguous,
      noRecipient,
      noTransfer,
      dbWriteFailed,
      unpaidLink,
      wrongPeriod,
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Admin: attach one Wise transfer to one payment, by operator decision.
 *
 * The counterpart to wiseMatch's suggestions — the matcher keys on recipient id
 * and cannot claim a transfer sent to an account the profile doesn't hold, so
 * the operator confirms those. Status-only; creates nothing in Wise and never
 * rewrites the payroll amount (a variance is recorded in the audit trail).
 */
/** One payment in a period, with its transfer or the transfers it could be. */
export interface PeriodMatchRow {
  paymentId: string;
  workerName: string;
  netPhp: number;
  status: string;
  payoutMethod: string | null;
  /** The linked Wise transfer, or null when the row is still unmatched. */
  transferId: string | null;
  /** Why the matcher declined, for unmatched rows. */
  reason: string | null;
  /** The operator's own record — every link/unlink reason, newest last. */
  note: string | null;
  /** Wise amount − payroll net, when they differ. The matcher no longer restates
   *  net_php from the transfer, so this gap is shown and attributed instead. */
  delta: number | null;
  /** An attribution was applied to this row — so it can be undone. */
  attributed: boolean;
  /** The linked transfer is an unfunded draft: still live in Wise, still
   *  fundable, and blocking this row from being re-matched. */
  cancellable: boolean;
  candidates: OrphanCandidate[];
}

/**
 * Everything in one period, as the reconcile view shows it: who was paid, which
 * Wise transfer paid them, and for the ones still unmatched, the transfers that
 * could be it.
 *
 * READ-ONLY — the match runs in dry-run, so opening a period never links a
 * transfer or restates an amount. Only the Match button writes.
 */
export async function wisePeriodMatches(
  payPeriodId: string,
): Promise<WiseActionResult<PeriodMatchRow[]>> {
  try {
    await requireAdmin();
    if (!payPeriodId) return fail('No period selected.');

    const db = createServiceClient();
    const rows = await fetchPeriodPayments(db, payPeriodId);

    // Only pay for the Wise pull when the period has wise rows at all. ONE
    // dry-run refresh pass decides everything: unmatched rows get discovery
    // suggestions, and LINKED rows are re-checked too — a row can hold a
    // transfer that never paid (a cancelled ghost, an unfunded draft), and
    // without that check the period reads as fully reconciled while the
    // transfer that actually paid it sits unclaimed.
    const suggestions = new Map<string, UnlinkedPayment>();
    const deltas = new Map<string, number>();
    const cancellable = new Set<string>();
    const wiseRows = rows.filter((r) => r.payoutMethod === 'wise');
    if (wiseRows.length > 0) {
      const res = await serviceMatch(db, { payPeriodId, dryRun: true, refresh: true });
      for (const u of res.unlinked) suggestions.set(u.paymentId, u);
      for (const r of res.results) {
        if ('delta' in r && Math.abs(r.delta) >= 0.01) deltas.set(r.payment_id, r.delta);
        if (r.outcome === 'refresh_transfer_unfunded') cancellable.add(r.payment_id);
      }
    }
    const attributed = await paymentsWithAttribution(
      db,
      rows.map((r) => r.id),
    );

    return ok(
      rows.map((r): PeriodMatchRow => {
        const s = suggestions.get(r.id);
        return {
          paymentId: r.id,
          workerName: r.workerName,
          netPhp: r.netPhp,
          status: r.status,
          payoutMethod: r.payoutMethod,
          transferId: r.wiseTransferId,
          // A reason on a LINKED row is the warning that its transfer never paid.
          reason: s?.reason ?? null,
          note: r.note,
          delta: deltas.get(r.id) ?? null,
          attributed: attributed.has(r.id),
          cancellable: cancellable.has(r.id),
          candidates: s?.candidates ?? [],
        };
      }),
    );
  } catch (e) {
    return fail(e);
  }
}

export async function wiseLinkTransfer(
  paymentId: string,
  transferId: string,
  reason?: string,
): Promise<WiseActionResult<LinkTransferResult>> {
  try {
    await requireAdmin();
    const parsed = WiseLinkTransferSchema.safeParse({ paymentId, transferId, reason });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');

    const db = createServiceClient();
    const { data: row, error } = await db
      .from('payments')
      .select('id, net_php, wise_transfer_id, note, pay_periods(period_start, pay_date)')
      .eq('id', parsed.data.paymentId)
      .maybeSingle();
    if (error) return fail(error.message);
    if (!row) return fail('Payment not found.');
    // Overwriting a stored id orphans the transfer it points at — the same
    // hazard RP-09 guards on the draft path. Unlink (with a reason) is the way
    // to move a link now that it exists.
    if (row.wise_transfer_id) {
      return fail(`Already linked to transfer ${row.wise_transfer_id}. Unlink it first.`);
    }

    const result = await serviceLinkTransfer(
      db,
      parsed.data.paymentId,
      parsed.data.transferId,
      Number(row.net_php ?? 0),
      {
        reason: parsed.data.reason,
        note: row.note,
        window: {
          periodStart: row.pay_periods?.period_start ?? null,
          payDate: row.pay_periods?.pay_date ?? null,
        },
      },
    );

    void logEvent({
      action: 'wise_match',
      entity: 'payments',
      detail: {
        kind: 'manual_link',
        paymentId: parsed.data.paymentId,
        transferId: result.transferId,
        wiseStatus: result.wiseStatus,
        dbAmount: result.dbAmount,
        wiseAmount: result.wiseAmount,
        delta: result.delta,
        outOfWindow: result.outOfWindow ?? false,
        reason: parsed.data.reason ?? null,
      },
    });

    return ok(result);
  } catch (e) {
    return fail(e);
  }
}

/**
 * Admin: detach the Wise transfer a payment holds, with a reason.
 *
 * Clears the id, the dates, the lock and paid_at, and drops `reconciled` back to
 * `sent` — the row stops claiming a transfer paid it. The reason is appended to
 * the payment's note and to the audit trail, because after this write nothing
 * else records which transfer it used to be.
 */
export async function wiseUnlinkTransfer(
  paymentId: string,
  reason: string,
): Promise<WiseActionResult<UnlinkTransferResult>> {
  try {
    await requireAdmin();
    const parsed = WiseUnlinkTransferSchema.safeParse({ paymentId, reason });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');

    const db = createServiceClient();
    const { data: row, error } = await db
      .from('payments')
      .select('id, wise_transfer_id, status, note')
      .eq('id', parsed.data.paymentId)
      .maybeSingle();
    if (error) return fail(error.message);
    if (!row) return fail('Payment not found.');

    const result = await serviceUnlinkTransfer(db, row, parsed.data.reason);

    void logEvent({
      action: 'wise_match',
      entity: 'payments',
      detail: {
        kind: 'manual_unlink',
        paymentId: result.paymentId,
        transferId: result.transferId,
        wiseStatus: result.wiseStatus,
        previousStatus: row.status,
        reason: parsed.data.reason,
      },
    });

    return ok(result);
  } catch (e) {
    return fail(e);
  }
}

/** The selected columns, as the attribution planner wants them. */
const toAttributionPayment = (row: {
  id: string;
  net_php: number | null;
  gross_php: number;
  health_allowance_php: number | null;
  thirteenth_month_php: number | null;
  pdd_lunch_php: number | null;
  bonus_php: number | null;
  misc_items: unknown;
  off_cycle_php: number | null;
  wise_transfer_id: string | null;
}): AttributionPayment => ({
  id: row.id,
  net_php: row.net_php,
  gross_php: row.gross_php,
  health_allowance_php: row.health_allowance_php,
  thirteenth_month_php: row.thirteenth_month_php,
  pdd_lunch_php: row.pdd_lunch_php,
  bonus_php: row.bonus_php,
  misc_items: Array.isArray(row.misc_items)
    ? (row.misc_items as AttributionPayment['misc_items'])
    : [],
  off_cycle_php: row.off_cycle_php,
  wise_transfer_id: row.wise_transfer_id,
});

/** Columns an attribution reads. Selected once and reused for the undo path. */
const ATTRIBUTION_COLS =
  'id, company_id, net_php, gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php, bonus_php, misc_items, off_cycle_php, wise_transfer_id';

/**
 * Admin: put the difference between the payroll net and what Wise actually sent
 * somewhere it can be read — miscellaneous (with a label and a client), health
 * allowance, or 13th month.
 *
 * This is the replacement for the matcher's silent net_php override. The amount
 * is never client input: it is read from the linked transfer, so the worst a
 * mis-click can do is put a known number in the wrong place, which the undo
 * reverses exactly.
 */
export async function wiseAttributeVariance(
  paymentId: string,
  target: AttributionTarget,
  label?: string,
  companyId?: string,
): Promise<WiseActionResult<AttributionResult>> {
  try {
    await requireAdmin();
    const parsed = WiseAttributeSchema.safeParse({ paymentId, target, label, companyId });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');

    const db = createServiceClient();
    const { data: row, error } = await db
      .from('payments')
      .select(ATTRIBUTION_COLS)
      .eq('id', parsed.data.paymentId)
      .maybeSingle();
    if (error) return fail(error.message);
    if (!row) return fail('Payment not found.');

    const result = await serviceAttributeVariance(db, toAttributionPayment(row), {
      target: parsed.data.target,
      label: parsed.data.label,
      companyId: parsed.data.companyId,
    });

    void logEvent({
      // #93: the PAYROLL company owns the audit row (its RLS is
      // is_company_admin(company_id)) — the attributed client goes in detail.
      companyId: row.company_id,
      action: ATTRIBUTION_ACTION,
      entity: parsed.data.paymentId,
      detail: {
        target: parsed.data.target,
        delta: result.delta,
        prevValue: result.prevValue,
        label: result.label,
        companyId: parsed.data.companyId ?? null,
        netPhp: result.netPhp,
        wiseAmount: result.wiseAmount,
      },
    });
    revalidatePath('/batches');

    return ok(result);
  } catch (e) {
    return fail(e);
  }
}

/**
 * Admin: reverse the last attribution on a payment.
 *
 * Without this a mis-picked target is permanent — once net matches the transfer
 * there is no variance left, and the attribute action refuses to fire again.
 */
export async function wiseUndoAttribution(
  paymentId: string,
): Promise<WiseActionResult<{ netPhp: number }>> {
  try {
    await requireAdmin();
    const parsed = WiseUndoAttributionSchema.safeParse({ paymentId });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');

    const db = createServiceClient();
    const last = await lastAttribution(db, parsed.data.paymentId);
    if (!last) return fail('Nothing to undo — this payment has no attribution on record.');

    const { data: row, error } = await db
      .from('payments')
      .select(ATTRIBUTION_COLS)
      .eq('id', parsed.data.paymentId)
      .maybeSingle();
    if (error) return fail(error.message);
    if (!row) return fail('Payment not found.');

    const rec = last.detail as unknown as AttributionRecord;
    const result = await serviceUndoAttribution(db, toAttributionPayment(row), rec);

    void logEvent({
      companyId: row.company_id,
      action: ATTRIBUTION_UNDO_ACTION,
      entity: parsed.data.paymentId,
      detail: { undid: last.id, target: rec.target, delta: -rec.delta },
    });
    revalidatePath('/batches');

    return ok(result);
  } catch (e) {
    return fail(e);
  }
}

/**
 * OWNER-only: cancel the unfunded Wise transfer a payment is holding.
 *
 * Drafting is owner-gated, so undoing it is too. NOT a funding call (ADR-0007):
 * it is the one direction that can only reduce money movement, and it is what
 * unblocks a row the app otherwise refuses to touch — while the draft is live,
 * unlink and re-match both stand down rather than orphan a fundable transfer.
 */
export async function wiseCancelTransfer(
  paymentId: string,
  reason?: string,
): Promise<WiseActionResult<CancelTransferResult>> {
  try {
    await requireOwner();
    const parsed = WiseCancelTransferSchema.safeParse({ paymentId, reason });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');

    const db = createServiceClient();
    const { data: row, error } = await db
      .from('payments')
      .select('id, company_id, wise_transfer_id, note')
      .eq('id', parsed.data.paymentId)
      .maybeSingle();
    if (error) return fail(error.message);
    if (!row) return fail('Payment not found.');

    const result = await serviceCancelTransfer(db, row, parsed.data.reason);

    void logEvent({
      companyId: row.company_id,
      action: 'wise_cancel',
      entity: parsed.data.paymentId,
      detail: {
        transferId: result.transferId,
        previousStatus: result.previousStatus,
        status: result.status,
        reason: parsed.data.reason ?? null,
      },
    });
    revalidatePath('/batches');

    return ok(result);
  } catch (e) {
    return fail(e);
  }
}

// ─── admin read-only lookups ──────────────────────────────────────────────────

/** Admin: transfer status lookups for the given payment ids. */
export async function wiseStatus(
  paymentIds: string[],
): Promise<WiseActionResult<{ paymentId: string; status: string; wiseStatus?: string }[]>> {
  try {
    await requireAdmin();
    const parsed = WiseStatusSchema.safeParse({ paymentIds });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');

    const db = createServiceClient();
    // Look up the wise_transfer_id for each payment id.
    const { data, error } = await db
      .from('payments')
      .select('id, wise_transfer_id, status')
      .in('id', parsed.data.paymentIds);
    if (error) return fail(error.message);

    const rows = data ?? [];
    const transferIds = rows
      .map((r) => r.wise_transfer_id)
      .filter((id): id is string => id !== null);

    const wiseStatuses = transferIds.length > 0 ? await serviceStatus(transferIds) : [];
    const byTransferId = new Map(wiseStatuses.map((s) => [String(s.id), s]));

    return ok(
      rows.map((r) => {
        const ws = r.wise_transfer_id ? byTransferId.get(r.wise_transfer_id) : undefined;
        return {
          paymentId: r.id,
          status: r.status,
          ...(ws?.status !== undefined && ws.status !== null ? { wiseStatus: ws.status } : {}),
        };
      }),
    );
  } catch (e) {
    return fail(e);
  }
}

/** Admin: recipient list for the profile panel. */
export async function wiseRecipients(): Promise<WiseActionResult<unknown[]>> {
  try {
    await requireAdmin();
    const { recipients } = await serviceRecipients();
    return ok(recipients);
  } catch (e) {
    return fail(e);
  }
}

// No type re-exports from this 'use server' module — the dev server-actions
// loader can compile `export type { … }` into a runtime export reference and
// crash every action bundled with this route. Import these types from
// '@/lib/wise/recipient-match' instead.
export interface PullRecipientsResult {
  total: number;
  alreadyLinked: number;
  matched: number;
  unmatched: number;
  /** Rows actually written this call — 0 on a preview (no `linkRecipientIds`). */
  linked: number;
  rows: PullRecipientRow[];
}

/**
 * Pull recipient IDs from Wise (legacy "Pull IDs from Wise", manifest 21).
 * READ-ONLY against Wise — lists saved recipients and, per recipient, finds its
 * contractor by stored Wise ID first (→ "already linked"), then by normalized
 * name (→ "matched"); otherwise "unmatched". Returns the full per-recipient
 * breakdown so the UI shows the legacy table. Never pulls bank details and
 * moves no money.
 *
 * RP-56: a bare normalized-name hit is a PROPOSAL, not a link — writing it sets
 * where that contractor's pay lands, so it needs the same confirmation and the
 * same OWNER gate as drafting. Call with no args to preview; call again with the
 * recipient ids the owner confirmed to write those links.
 */
export async function wisePullRecipientIds(
  linkRecipientIds?: number[],
): Promise<WiseActionResult<PullRecipientsResult>> {
  try {
    const confirmed = new Set(linkRecipientIds ?? []);
    // Preview is a read (any admin); writing payee identity is owner-only.
    await (confirmed.size > 0 ? requireOwner() : requireAdmin());
    const { recipients } = await serviceRecipients();

    const db = createServiceClient();
    // All statuses on purpose — see planRecipientMatches (an ended contractor
    // that holds a recipient id is still "already linked").
    const { data: workers, error } = await db
      .from('workers')
      .select('id, first_name, middle_name, last_name, wise_recipient_id, status');
    if (error) return fail(error.message);

    const fullName = (w: {
      first_name: string;
      middle_name: string | null;
      last_name: string;
    }): string => [w.first_name, w.middle_name, w.last_name].filter(Boolean).join(' ');

    const rows = planRecipientMatches(
      recipients.map((r) => ({
        id: r.id,
        name: r.name,
        currency: r.currency,
        account: r.account,
      })),
      (workers ?? []).map((w) => ({
        id: w.id,
        name: fullName(w),
        status: w.status,
        wiseRecipientId: w.wise_recipient_id,
      })),
    );

    // Write only the name-matches the owner explicitly confirmed; downgrade the
    // row to "unmatched" if the write fails so the count stays honest.
    let linked = 0;
    for (const row of rows) {
      if (row.status === 'matched' && row.contractor && confirmed.has(row.recipientId)) {
        const { error: upErr } = await db
          .from('workers')
          .update({ wise_recipient_id: row.recipientId })
          .eq('id', row.contractor.id);
        if (upErr) {
          row.status = 'unmatched';
          row.contractor = null;
        } else {
          row.linked = true;
          linked++;
        }
      }
    }

    const alreadyLinked = rows.filter((r) => r.status === 'already-linked').length;
    const matched = rows.filter((r) => r.status === 'matched').length;
    const unmatched = rows.filter((r) => r.status === 'unmatched').length;

    void logEvent({
      action: 'wise_pull_recipient_ids',
      entity: 'workers',
      detail: { total: recipients.length, alreadyLinked, matched, unmatched, linked },
    });
    if (linked > 0) revalidatePath('/contractors');
    return ok({ total: recipients.length, alreadyLinked, matched, unmatched, linked, rows });
  } catch (e) {
    return fail(e);
  }
}

/** Admin: single recipient lookup. */
export async function wiseGetRecipient(recipientId: number): Promise<WiseActionResult<unknown>> {
  try {
    await requireAdmin();
    const parsed = WiseGetRecipientSchema.safeParse({ recipientId });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');

    const recipient = await serviceGetRecipient(parsed.data.recipientId);
    if (!recipient) return fail(await explainMissingRecipient(recipientId));
    return ok(recipient);
  } catch (e) {
    return fail(e);
  }
}

/** Admin: find all Wise transfers to a specific recipient in a date window. */
export async function wiseFindTransfersByRecipient(
  recipientId: number,
): Promise<WiseActionResult<unknown[]>> {
  try {
    await requireAdmin();
    const parsed = WiseFindTransfersSchema.safeParse({ recipientId });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');

    const result = await serviceFindTransfersByRecipient(parsed.data.recipientId);
    return ok(result.matches);
  } catch (e) {
    return fail(e);
  }
}
