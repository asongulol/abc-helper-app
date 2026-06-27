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

/* ---------- off-cycle per-session / per-hour pay ---------- */

export const OffCyclePayBasisSchema = z.enum(['per_session', 'per_hour']);
export type OffCyclePayBasis = z.infer<typeof OffCyclePayBasisSchema>;

/**
 * Add an off-cycle pay entry to a worker's row on the (open) period.
 *  - mode 'pick'  : pay existing approved, unpaid sessions by their ids
 *                   (per_session only); amount = Σ units × rate.
 *  - mode 'manual': type the entry (date + units/hours + description); amount =
 *                   units × rate, or an explicit amountPhp.
 * The period need not contain the session/work date — that is the whole point —
 * but the action refuses a locked/paid period and the DB guards double-pay.
 */
export const AddOffCyclePaySchema = PeriodKeySchema.extend({
  workerId: z.string().uuid(),
  basis: OffCyclePayBasisSchema,
  description: z.string().min(1, 'Description is required').max(200),
  mode: z.enum(['pick', 'manual']),
  /** pick mode: service_sessions ids to pay (per_session only). */
  sessionIds: z.array(z.string().uuid()).optional(),
  /** manual mode: the work/session date (may be outside the period window). */
  workDate: IsoDateSchema.optional(),
  /** manual mode: sessions (per_session) or hours (per_hour). */
  units: z.number().positive().optional(),
  /** Optional explicit amount (PHP major units); else computed units × rate. */
  amountPhp: z.number().positive().multipleOf(0.01).optional(),
}).superRefine((val, ctx) => {
  if (val.mode === 'pick') {
    if (val.basis !== 'per_session')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Pick mode is for per-session pay.',
        path: ['mode'],
      });
    if (!val.sessionIds || val.sessionIds.length === 0)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Select at least one session.',
        path: ['sessionIds'],
      });
  } else {
    if (!val.workDate)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A date is required.',
        path: ['workDate'],
      });
    if (val.units == null && val.amountPhp == null)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter units/hours or an amount.',
        path: ['units'],
      });
  }
});
export type AddOffCyclePayInput = z.infer<typeof AddOffCyclePaySchema>;

export const RemoveOffCyclePaySchema = z.object({
  companyId: z.string().uuid(),
  itemId: z.string().uuid(),
});
export type RemoveOffCyclePayInput = z.infer<typeof RemoveOffCyclePaySchema>;

export const ToggleWiseRowLockSchema = z.object({
  paymentId: uuid(),
  companyId: uuid(),
  /** Lock: provide a timestamp. Unlock: omit or null. */
  lockedAt: z.string().datetime().nullable().optional(),
  reason: z.string().min(1).optional(),
});
export type ToggleWiseRowLockInput = z.infer<typeof ToggleWiseRowLockSchema>;
