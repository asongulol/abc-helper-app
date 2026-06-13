/**
 * Zod schemas for contractor server-action trust boundaries.
 * Every contractors action validates its input with these before touching data.
 */

import { z } from 'zod';

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

export const PayoutMethodSchema = z.enum(['wise', 'bpi', 'gcash', 'paymaya', 'paypal']);
export const ContractTypeSchema = z.enum(['FT', 'PT']);
export const WorkerStatusSchema = z.enum(['active', 'inactive', 'ended']);

/** Create a minimal contractor (quick-add) and link to a company. */
export const AddContractorSchema = z.object({
  companyId: z.string().uuid(),
  firstName: z.string().min(1, 'First name required').max(80),
  lastName: z.string().min(1, 'Last name required').max(80),
  contract: ContractTypeSchema.default('FT'),
  /** Optional Hubstaff source name to set on the link immediately (used by CSV import). */
  hubstaffName: z.string().max(100).optional(),
});
export type AddContractorInput = z.infer<typeof AddContractorSchema>;

/** Worker profile fields the admin can edit. */
export const SaveWorkerProfileSchema = z.object({
  workerId: z.string().uuid(),
  companyId: z.string().uuid(),
  // worker table fields
  firstName: z.string().min(1).max(80),
  middleName: z.string().max(80).nullable(),
  lastName: z.string().min(1).max(80),
  email: z
    .string()
    .email()
    .nullable()
    .or(z.literal(''))
    .transform((v) => v || null),
  mobile: z.string().max(40).nullable(),
  hireDate: IsoDateSchema.nullable(),
  phAddress: z.string().max(255).nullable(),
  permanentAddress: z.string().max(255).nullable(),
  addressLandmark: z.string().max(255).nullable(),
  postalCode: z.string().max(20).nullable(),
  payoutMethod: PayoutMethodSchema.nullable(),
  healthAllowanceEligible: z.boolean(),
  thirteenthMonthEligible: z.boolean(),
  // worker_companies link fields
  contract: ContractTypeSchema,
  role: z.string().max(100).nullable(),
  hubstaffName: z.string().max(100).nullable(),
  weeklyHours: z.number().min(0).max(168).nullable(),
  linkStatus: WorkerStatusSchema,
});
export type SaveWorkerProfileInput = z.infer<typeof SaveWorkerProfileSchema>;

/** Deactivate/reactivate a worker's link to a company. */
export const SetLinkStatusSchema = z.object({
  workerId: z.string().uuid(),
  companyId: z.string().uuid(),
  active: z.boolean(),
});
export type SetLinkStatusInput = z.infer<typeof SetLinkStatusSchema>;
