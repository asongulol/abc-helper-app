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

/* ---------- new schemas for payroll/process screens ---------- */

export const LockPeriodSchema = PeriodKeySchema.extend({
  /** When true the caller already confirmed missing-rate / inactive rows. */
  confirmed: z.boolean().optional(),
});
export type LockPeriodInput = z.infer<typeof LockPeriodSchema>;

export const UnlockPeriodSchema = PeriodKeySchema.extend({
  reason: z.string().min(1, 'Reason is required'),
});
export type UnlockPeriodInput = z.infer<typeof UnlockPeriodSchema>;

export const UpdatePaymentRowSchema = z.object({
  paymentId: z.string().uuid(),
  companyId: z.string().uuid(),
  /** PHP major units — null = clear the override */
  grossPhpOverride: z.number().positive().nullable().optional(),
  haPhp: z.number().min(0).optional(),
  t13Php: z.number().min(0).nullable().optional(),
  pddPhp: z.number().min(0).optional(),
  bonusPhp: z.number().min(0).optional(),
  miscItems: z.array(MiscItemSchema).optional(),
  payoutMethod: PayoutMethodSchema.nullable().optional(),
  fxRate: z.number().positive().optional(),
});
export type UpdatePaymentRowInput = z.infer<typeof UpdatePaymentRowSchema>;

export const DeleteStatementSchema = z.object({
  paymentId: z.string().uuid(),
  companyId: z.string().uuid(),
});
export type DeleteStatementInput = z.infer<typeof DeleteStatementSchema>;

export const DeleteAllStatementsSchema = PeriodKeySchema;
export type DeleteAllStatementsInput = z.infer<typeof DeleteAllStatementsSchema>;

export const MarkPaidSchema = z.object({
  paymentIds: z.array(z.string().uuid()).min(1),
  companyId: z.string().uuid(),
  paidAt: z.string().datetime().optional(),
});
export type MarkPaidInput = z.infer<typeof MarkPaidSchema>;

export const MarkUnpaidSchema = z.object({
  paymentIds: z.array(z.string().uuid()).min(1),
  companyId: z.string().uuid(),
});
export type MarkUnpaidInput = z.infer<typeof MarkUnpaidSchema>;

export const MarkAllUnpaidSchema = z.object({
  periodId: z.string().uuid(),
  companyId: z.string().uuid(),
});
export type MarkAllUnpaidInput = z.infer<typeof MarkAllUnpaidSchema>;

export const ToggleWiseRowLockSchema = z.object({
  paymentId: z.string().uuid(),
  companyId: z.string().uuid(),
  /** Lock: provide a timestamp. Unlock: omit or null. */
  lockedAt: z.string().datetime().nullable().optional(),
  reason: z.string().min(1).optional(),
});
export type ToggleWiseRowLockInput = z.infer<typeof ToggleWiseRowLockSchema>;
