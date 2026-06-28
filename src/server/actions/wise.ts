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
 *   wisePoll  / wiseMatch  → any admin
 *     (the cron path — x-cron-secret — stays in the deployed Deno edge function
 *      supabase/functions/wise-payouts/index.ts; this action covers the
 *      on-demand admin-triggered path only)
 *   lookups (wiseStatus, wiseRecipients, wiseGetRecipient,
 *            wiseFindTransfersByRecipient) → any admin
 */

import { revalidatePath } from 'next/cache';
import { createServiceClient } from '@/db/clients/service';
import { logEvent } from '@/server/audit';
import { requireAdmin, requireOwner } from '@/server/auth/admin';
import {
  serviceBatch,
  serviceDraft,
  serviceFindTransfersByRecipient,
  serviceGetRecipient,
  serviceMatch,
  servicePoll,
  serviceRecipients,
  serviceStatus,
} from '@/server/wise/service';
import {
  type WiseBatchItem,
  WiseBatchSchema,
  WiseDraftSchema,
  WiseFindTransfersSchema,
  WiseGetRecipientSchema,
  WiseMatchSchema,
  WiseStatusSchema,
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
    const { batchGroupId, results } = await serviceBatch(db, parsed.data.items, parsed.data.name);

    void logEvent({
      action: 'wise_batch',
      entity: 'payments',
      detail: {
        batchGroupId,
        count: results.length,
        drafted: results.filter((r) => r.status === 'drafted').length,
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
 * Note: the cron path stays in the deployed Deno edge function.
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
}): Promise<WiseActionResult<{ matched: number; suggestions: unknown[] }>> {
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

    return ok({
      matched: result.matched,
      suggestions: result.results.filter(
        (r) => r.outcome === 'no_wise_transfer' || r.outcome === 'no_wise_transfer_in_window',
      ),
    });
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

/**
 * Admin: pull recipient IDs from Wise and store them on matched contractors
 * (legacy "Pull IDs from Wise", manifest 21). READ-ONLY against Wise — lists
 * saved recipients and matches each to a worker by normalized name, then writes
 * the numeric recipient id onto workers that don't already have one. Never pulls
 * bank details and moves no money.
 */
export async function wisePullRecipientIds(): Promise<
  WiseActionResult<{ total: number; matched: number; updated: number }>
> {
  try {
    await requireAdmin();
    const { recipients } = await serviceRecipients();

    const db = createServiceClient();
    const { data: workers, error } = await db
      .from('workers')
      .select('id, first_name, middle_name, last_name, wise_recipient_id')
      .neq('status', 'ended');
    if (error) return fail(error.message);

    const norm = (s: string): string =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

    // Index workers WITHOUT a stored recipient id, by normalized full name.
    const byName = new Map<string, string>();
    for (const w of workers ?? []) {
      if (w.wise_recipient_id != null) continue;
      const key = norm([w.first_name, w.middle_name, w.last_name].filter(Boolean).join(' '));
      if (key && !byName.has(key)) byName.set(key, w.id);
    }

    let matched = 0;
    let updated = 0;
    for (const r of recipients) {
      const name = typeof r === 'object' && r != null ? ((r as { name?: string }).name ?? '') : '';
      const id = typeof r === 'object' && r != null ? (r as { id?: number }).id : undefined;
      if (!name || id == null) continue;
      const workerId = byName.get(norm(name));
      if (!workerId) continue;
      matched++;
      const { error: upErr } = await db
        .from('workers')
        .update({ wise_recipient_id: id })
        .eq('id', workerId);
      if (!upErr) {
        updated++;
        byName.delete(norm(name)); // one recipient per worker
      }
    }

    void logEvent({
      action: 'wise_pull_recipient_ids',
      entity: 'workers',
      detail: { total: recipients.length, matched, updated },
    });
    revalidatePath('/contractors');
    return ok({ total: recipients.length, matched, updated });
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
    if (!recipient) return fail(`Recipient ${recipientId} not found`);
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
