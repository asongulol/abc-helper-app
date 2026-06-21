/**
 * Zod schemas for the coverage-target management actions (admin trust boundary).
 */

import { z } from 'zod';

export const SetCoverageTargetSchema = z.object({
  companyId: z.string().uuid(),
  workerId: z.string().uuid(),
  /** Expected hours for the period (semi-monthly by default). */
  targetHours: z.number().min(0).max(1000),
  periodKind: z.enum(['weekly', 'semi_monthly']).default('semi_monthly'),
});
export type SetCoverageTargetInput = z.infer<typeof SetCoverageTargetSchema>;

export const ClearCoverageTargetSchema = z.object({
  companyId: z.string().uuid(),
  workerId: z.string().uuid(),
});
export type ClearCoverageTargetInput = z.infer<typeof ClearCoverageTargetSchema>;
