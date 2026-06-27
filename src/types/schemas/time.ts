/**
 * Zod schemas for time-import trust boundaries (server-action inputs).
 * Every time action validates with these before touching data.
 */

import { z } from 'zod';
import { uuid } from './uuid';

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

/** Approve or reject time entries (per-contractor or bulk). */
export const SetApprovalSchema = z.object({
  companyId: uuid(),
  ids: z.array(uuid()).min(1),
  status: z.enum(['approved', 'rejected']),
});
export type SetApprovalInput = z.infer<typeof SetApprovalSchema>;

/** Total-mode manual hours: one row on the period's first day. */
export const AddHoursTotalSchema = z.object({
  companyId: uuid(),
  workerId: uuid().nullable(),
  sourceName: z.string().min(1),
  periodStart: IsoDateSchema,
  hours: z.number().positive(),
  /** CLIENT these hours bill to (invoicing attribution); omit for unattributed. */
  clientId: z.string().uuid().nullable().optional(),
});
export type AddHoursTotalInput = z.infer<typeof AddHoursTotalSchema>;

/** Daily-mode manual hours: one row per day with hours > 0. */
export const AddHoursDailySchema = z.object({
  companyId: uuid(),
  workerId: uuid().nullable(),
  sourceName: z.string().min(1),
  clientId: z.string().uuid().nullable().optional(),
  days: z
    .array(
      z.object({
        date: IsoDateSchema,
        hours: z.number().positive(),
      }),
    )
    .min(1),
});
export type AddHoursDailyInput = z.infer<typeof AddHoursDailySchema>;

/** Edit-total: rewrite an existing contractor's period total onto first day,
 *  zeroing the rest. Requires the existing entry ids sorted ascending by date. */
export const EditTotalSchema = z.object({
  companyId: uuid(),
  sourceName: z.string().min(1),
  /** All entry ids for this contractor/period, sorted earliest-first. */
  ids: z.array(uuid()).min(1),
  hours: z.number().nonnegative(),
  periodStart: IsoDateSchema,
  periodEnd: IsoDateSchema,
});
export type EditTotalInput = z.infer<typeof EditTotalSchema>;

/** CSV import: array of parsed rows summed per (name, date). */
export const CsvImportRowSchema = z.object({
  sourceName: z.string().min(1),
  workerId: uuid().nullable(),
  workDate: IsoDateSchema,
  trackedSeconds: z.number().int().nonnegative(),
  activityPct: z.number().nullable(),
});

export const CsvImportSchema = z.object({
  companyId: uuid(),
  rows: z.array(CsvImportRowSchema).min(1),
  /** 'upsert' = overwrite existing; 'skip' = only new rows. */
  mode: z.enum(['upsert', 'skip']),
});
export type CsvImportInput = z.infer<typeof CsvImportSchema>;

/** Delete an import batch by batch uuid. */
export const DeleteBatchSchema = z.object({
  companyId: uuid(),
  batchId: uuid(),
});
export type DeleteBatchInput = z.infer<typeof DeleteBatchSchema>;

/** Undo payload: an id+prior-approval pair for each affected entry. */
export const UndoApprovalEntrySchema = z.object({
  id: uuid(),
  approval: z.enum(['pending', 'approved', 'rejected']),
});

export const UndoApprovalSchema = z.object({
  companyId: uuid(),
  entries: z.array(UndoApprovalEntrySchema).min(1),
});
export type UndoApprovalInput = z.infer<typeof UndoApprovalSchema>;
