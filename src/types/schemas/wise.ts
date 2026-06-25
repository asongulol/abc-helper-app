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

export const WiseBatchSchema = z.object({
  paymentIds: PaymentIdsSchema,
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

export const WiseStatusSchema = z.object({
  paymentIds: PaymentIdsSchema,
});
export type WiseStatusInput = z.infer<typeof WiseStatusSchema>;

export const WiseGetRecipientSchema = z.object({
  recipientId: z.number().int().positive(),
});
export type WiseGetRecipientInput = z.infer<typeof WiseGetRecipientSchema>;

/** Search Wise contacts by Wisetag (legacy `search_contacts`). */
export const WiseSearchContactsSchema = z.object({
  searchTerm: z.string().trim().min(1, 'Enter a search term').max(100),
});
export type WiseSearchContactsInput = z.infer<typeof WiseSearchContactsSchema>;

export const WiseFindTransfersSchema = z.object({
  recipientId: z.number().int().positive(),
  /** ISO date string (YYYY-MM-DD or full ISO). Defaults to 90 days ago. */
  fromIso: z.string().optional(),
  /** ISO date string. Defaults to now. */
  toIso: z.string().optional(),
});
export type WiseFindTransfersInput = z.infer<typeof WiseFindTransfersSchema>;
