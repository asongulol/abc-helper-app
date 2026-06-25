/**
 * Zod schemas for payroll trust boundaries (server-action inputs).
 * Every server action validates its input with these before touching data
 * (ADR pattern: Zod at every trust boundary).
 */

import { z } from 'zod';
import { periodFor } from '@/lib/dates/periods';
import { uuid } from './uuid';

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

export const PeriodKeySchema = z.object({
  companyId: uuid(),
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
  workerId: uuid(),
  companyId: uuid(),
  amountPhp: z.number().positive().multipleOf(0.01),
  effectiveStart: IsoDateSchema,
});
export type RateSaveInput = z.infer<typeof RateSaveSchema>;

/** Edit one rate row's effective-from date (legacy `saveRateEffectiveEdit`). */
export const RateEditSchema = z.object({
  workerId: uuid(),
  companyId: uuid(),
  rateId: uuid(),
  effectiveStart: IsoDateSchema,
});
export type RateEditInput = z.infer<typeof RateEditSchema>;

/** Delete one rate row (legacy `deleteRateRow`). */
export const RateDeleteSchema = z.object({
  workerId: uuid(),
  companyId: uuid(),
  rateId: uuid(),
});
export type RateDeleteInput = z.infer<typeof RateDeleteSchema>;

/**
 * Batch calculate request (legacy `calculate`/`calcBatch`).
 *
 * F11: includeThirteenth defaults to false to match the UI (the 13th-month
 * accrual is an explicit, opt-in year-end run; a default of true would have any
 * caller that omits the flag over-accrue on every period).
 *
 * New-3: periodStart/periodEnd must be a canonical semi-monthly period
 * (1–15 or 16–EOM). Arbitrary/overlapping ranges would create distinct
 * pay_periods that each pull the shared work_dates and double-pay them.
 */
export const CalculateDraftSchema = PeriodKeySchema.extend({
  payDate: IsoDateSchema,
  includeHealthAllowance: z.boolean().default(true),
  includeThirteenth: z.boolean().default(false),
  /** PHP per USD, display reference only. */
  fxRate: z.number().positive().optional(),
}).superRefine((val, ctx) => {
  const canonical = periodFor(val.periodStart);
  if (canonical.start !== val.periodStart || canonical.end !== val.periodEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Period must be a semi-monthly range (expected ${canonical.start} → ${canonical.end}).`,
      path: ['periodEnd'],
    });
  }
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
  paymentId: uuid(),
  companyId: uuid(),
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

/** F6: restore a recalc undo snapshot (full payment rows captured pre-recalc). */
export const RestoreSnapshotSchema = z.object({
  companyId: uuid(),
  periodId: uuid(),
  snapshot: z.array(z.record(z.string(), z.unknown())),
});
export type RestoreSnapshotInput = z.infer<typeof RestoreSnapshotSchema>;

export const DeleteStatementSchema = z.object({
  paymentId: uuid(),
  companyId: uuid(),
});
export type DeleteStatementInput = z.infer<typeof DeleteStatementSchema>;

export const DeleteAllStatementsSchema = PeriodKeySchema;
export type DeleteAllStatementsInput = z.infer<typeof DeleteAllStatementsSchema>;

export const MarkPaidSchema = z.object({
  paymentIds: z.array(uuid()).min(1),
  companyId: uuid(),
  paidAt: z.string().datetime().optional(),
});
export type MarkPaidInput = z.infer<typeof MarkPaidSchema>;

export const MarkUnpaidSchema = z.object({
  paymentIds: z.array(uuid()).min(1),
  companyId: uuid(),
});
export type MarkUnpaidInput = z.infer<typeof MarkUnpaidSchema>;

export const MarkAllUnpaidSchema = z.object({
  periodId: uuid(),
  companyId: uuid(),
});
export type MarkAllUnpaidInput = z.infer<typeof MarkAllUnpaidSchema>;

export const ToggleWiseRowLockSchema = z.object({
  paymentId: uuid(),
  companyId: uuid(),
  /** Lock: provide a timestamp. Unlock: omit or null. */
  lockedAt: z.string().datetime().nullable().optional(),
  reason: z.string().min(1).optional(),
});
export type ToggleWiseRowLockInput = z.infer<typeof ToggleWiseRowLockSchema>;
