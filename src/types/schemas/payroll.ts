/**
 * Zod schemas for payroll trust boundaries (server-action inputs).
 * Every server action validates its input with these before touching data
 * (ADR pattern: Zod at every trust boundary).
 */

import { z } from 'zod';

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

export const PeriodKeySchema = z.object({
  companyId: z.string().uuid(),
  periodStart: IsoDateSchema,
  periodEnd: IsoDateSchema,
});
export type PeriodKey = z.infer<typeof PeriodKeySchema>;

export const PayoutMethodSchema = z.enum(['wise', 'bpi', 'gcash', 'paymaya', 'paypal']);

export const MiscItemSchema = z.object({
  kind: z.string().min(1),
  label: z.string().optional(),
  amount: z.union([z.number(), z.string()]).optional().nullable(),
  hours: z.union([z.number(), z.string()]).optional().nullable(),
});

/** Effective-dated rate save (legacy `saveRate`/`upsertRate`). PHP major units. */
export const RateSaveSchema = z.object({
  workerId: z.string().uuid(),
  companyId: z.string().uuid(),
  amountPhp: z.number().positive().multipleOf(0.01),
  effectiveStart: IsoDateSchema,
});
export type RateSaveInput = z.infer<typeof RateSaveSchema>;

/** Batch calculate request (legacy `calculate`/`calcBatch`). */
export const CalculateDraftSchema = PeriodKeySchema.extend({
  payDate: IsoDateSchema,
  includeHealthAllowance: z.boolean().default(true),
  includeThirteenth: z.boolean().default(true),
  /** PHP per USD, display reference only. */
  fxRate: z.number().positive().optional(),
});
export type CalculateDraftInput = z.infer<typeof CalculateDraftSchema>;
