/**
 * Zod schemas for Wise action inputs (server-action trust boundary).
 * ADR pattern: Zod at every trust boundary, co-located with the action.
 */

import { z } from 'zod';
import { uuid } from './uuid';

/** Non-empty UUID list — used for draft / batch / status actions. */
export const PaymentIdsSchema = z
  .array(uuid('each paymentId must be a UUID'))
  .min(1, 'at least one paymentId required');

export const WiseDraftSchema = z.object({
  paymentIds: PaymentIdsSchema,
});
export type WiseDraftInput = z.infer<typeof WiseDraftSchema>;

/**
 * One row of a Wise batch draft. `recipientId` / `amountPhp` are optional
 * per-row OVERRIDES — when omitted the draft uses the worker's saved default
 * recipient and the locked net. Drafts only: no money ever moves here.
 *
 * Shape only. `recipientId` must also BELONG to that payment's worker — Zod
 * can't see the DB, so wiseBatch enforces ownership (RP-54, foreignRecipientRows)
 * and logs the resolved per-row amount, which net_php never records.
 */
export const WiseBatchItemSchema = z.object({
  paymentId: uuid('paymentId must be a UUID'),
  recipientId: z.number().int().positive().optional(),
  amountPhp: z.number().positive().optional(),
});
export type WiseBatchItem = z.infer<typeof WiseBatchItemSchema>;

export const WiseBatchSchema = z.object({
  items: z.array(WiseBatchItemSchema).min(1, 'at least one item required').max(500),
  /** Optional display name for the Wise batch group. */
  name: z.string().min(1).max(200).optional(),
});
export type WiseBatchInput = z.infer<typeof WiseBatchSchema>;

export const WisePollSchema = z.object({
  /**
   * Default true — only re-check 'draft' rows (fast + idempotent).
   * Set false to re-check 'sent' rows too (useful for diagnostics).
   */
  onlyDrafts: z.boolean().optional(),
  /** Scope reconcile to a single pay period. */
  payPeriodId: uuid().optional(),
});
export type WisePollInput = z.infer<typeof WisePollSchema>;

export const WiseMatchSchema = z.object({
  /**
   * ±days window around pay_date for discovery matching.
   * Default 7 (half the biweekly cadence — see legacy comment 2026-05-28).
   */
  windowDays: z.number().int().min(1).max(60).optional(),
  /**
   * Re-fetch already-matched rows to backfill wise_dates / new fields.
   * Default false (normal match mode).
   */
  refresh: z.boolean().optional(),
  /** Scope to a single pay period. */
  payPeriodId: uuid().optional(),
});
export type WiseMatchInput = z.infer<typeof WiseMatchSchema>;

export const WiseLinkTransferSchema = z.object({
  paymentId: z.string().uuid('paymentId must be a UUID'),
  // Wise transfer ids are numeric; reject anything else before it reaches the
  // API path so a link can't be pointed at an arbitrary URL segment.
  transferId: z.string().regex(/^\d+$/, 'transferId must be a Wise transfer id'),
  /** Why this transfer, in the operator's words. Required for a link the
   *  matcher would never propose (outside the period's window). */
  reason: z.string().trim().max(500).optional(),
});
export type WiseLinkTransferInput = z.infer<typeof WiseLinkTransferSchema>;

export const WiseUnlinkTransferSchema = z.object({
  paymentId: z.string().uuid('paymentId must be a UUID'),
  // Always required: an unlink erases the only record of which transfer paid
  // this row, so the reason IS the record after it.
  reason: z.string().trim().min(3, 'say why — this is the only record of it').max(500),
});
export type WiseUnlinkTransferInput = z.infer<typeof WiseUnlinkTransferSchema>;

export const WiseStatusSchema = z.object({
  paymentIds: PaymentIdsSchema,
});
export type WiseStatusInput = z.infer<typeof WiseStatusSchema>;

export const WiseGetRecipientSchema = z.object({
  recipientId: z.number().int().positive(),
});
export type WiseGetRecipientInput = z.infer<typeof WiseGetRecipientSchema>;

export const WiseFindTransfersSchema = z.object({
  recipientId: z.number().int().positive(),
  /** ISO date string (YYYY-MM-DD or full ISO). Defaults to 90 days ago. */
  fromIso: z.string().optional(),
  /** ISO date string. Defaults to now. */
  toIso: z.string().optional(),
});
export type WiseFindTransfersInput = z.infer<typeof WiseFindTransfersSchema>;

export const WiseAttributeSchema = z.object({
  paymentId: z.string().uuid('paymentId must be a UUID'),
  /** Where the difference belongs. NOTE: no amount — the server reads it from
   *  the linked transfer, so this control can only close the gap it opened. */
  target: z.enum(['misc', 'health_allowance', 'thirteenth_month']),
  /** Free-text label for the misc line ("123 BT Bookkeeping"). */
  label: z.string().trim().max(120).optional(),
  /** Client the line is billed to (companies.id). Misc only — HA and 13th month
   *  are single columns with nowhere to hang it. */
  companyId: uuid().optional(),
});
export type WiseAttributeInput = z.infer<typeof WiseAttributeSchema>;

export const WiseUndoAttributionSchema = z.object({
  paymentId: z.string().uuid('paymentId must be a UUID'),
});
export type WiseUndoAttributionInput = z.infer<typeof WiseUndoAttributionSchema>;

export const WiseCancelTransferSchema = z.object({
  paymentId: z.string().uuid('paymentId must be a UUID'),
  /** Optional — cancelling is the safe direction, so it is not gated on prose. */
  reason: z.string().trim().max(500).optional(),
});
export type WiseCancelTransferInput = z.infer<typeof WiseCancelTransferSchema>;
