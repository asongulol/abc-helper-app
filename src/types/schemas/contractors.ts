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
  // Personal / HR (workers table) — all optional so partial edits are accepted.
  workEmail: z
    .string()
    .email()
    .nullable()
    .or(z.literal(''))
    .transform((v) => v || null)
    .optional(),
  workNumber: z.string().max(40).nullable().optional(),
  workExtension: z.string().max(20).nullable().optional(),
  shiftStart: z.string().max(5).nullable().optional(),
  shiftEnd: z.string().max(5).nullable().optional(),
  dateOfBirth: IsoDateSchema.nullable().optional(),
  emergencyName: z.string().max(120).nullable().optional(),
  emergencyRelationship: z.string().max(60).nullable().optional(),
  emergencyMobile: z.string().max(40).nullable().optional(),
  maritalStatus: z.string().max(40).nullable().optional(),
  educationLevel: z.string().max(60).nullable().optional(),
  course: z.string().max(120).nullable().optional(),
  yearGraduated: z.string().max(10).nullable().optional(),
  school: z.string().max(160).nullable().optional(),
  gcash: z.string().max(60).nullable().optional(),
  paymaya: z.string().max(60).nullable().optional(),
  paypal: z.string().max(120).nullable().optional(),
  wiseTag: z.string().max(60).nullable().optional(),
  // worker_companies link fields
  contract: ContractTypeSchema,
  role: z.string().max(100).nullable(),
  hubstaffName: z.string().max(100).nullable(),
  weeklyHours: z.number().min(0).max(168).nullable(),
  billRateUsd: z.number().min(0).max(100000).nullable().optional(),
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

/** IC Agreement addendum options on the hire wizard. */
export const IcAddendumTypeSchema = z.enum(['', 'scope_of_work', 'other']);

/** Tools to provision (logins entered later at onboarding completion). */
export const HireToolsSchema = z.object({
  gmail: z.boolean().default(false),
  providersoft: z.boolean().default(false),
  hubstaff: z.boolean().default(false),
  zoom: z.boolean().default(false),
  others: z.string().max(200).default(''),
});

/**
 * Full Add Contractor Wizard input — the transactional hire orchestrator
 * (`hireContractor`) validates against this. Mirrors the legacy 3-step wizard:
 * Identity (step 1), Engagement / IC terms (step 2), Portal & onboarding (step 3).
 */
export const HireContractorSchema = z.object({
  companyId: z.string().uuid(),
  // Step 1 — Identity
  firstName: z.string().min(1, 'First name required').max(80),
  middleName: z.string().max(80).nullable().default(null),
  lastName: z.string().min(1, 'Last name required').max(80),
  email: z
    .string()
    .email('Enter a valid email')
    .nullable()
    .or(z.literal(''))
    .transform((v) => v || null),
  phAddress: z.string().max(255).nullable().default(null),
  permanentAddress: z.string().max(255).nullable().default(null),
  dateOfBirth: IsoDateSchema.nullable().default(null),
  // Step 2 — Engagement / IC terms
  contract: ContractTypeSchema,
  weeklyHours: z.number().min(0).max(168).nullable().default(null),
  role: z.string().min(1, 'Role required').max(100),
  ratePhp: z.number().min(0).default(0),
  contractDate: IsoDateSchema.nullable().default(null),
  hireDate: IsoDateSchema,
  healthAllowanceEligible: z.boolean().default(true),
  thirteenthMonthEligible: z.boolean().default(true),
  /** Daily shift, stored in Philippine time (HH:MM). */
  shiftStart: z.string().max(5).nullable().default(null),
  shiftEnd: z.string().max(5).nullable().default(null),
  /** Schedule label snapshot for the agreements (e.g. "8:00 AM – 5:00 PM Eastern Time"). */
  shiftLabel: z.string().max(120).nullable().default(null),
  countersignerUserId: z.string().uuid().nullable().default(null),
  countersignerName: z.string().max(120).nullable().default(null),
  icAddendumType: IcAddendumTypeSchema.default(''),
  icAddendumText: z.string().max(5000).nullable().default(null),
  extraDocs: z.array(z.string().max(120)).max(20).default([]),
  // Step 3 — Portal & onboarding
  invite: z.boolean().default(true),
  tools: HireToolsSchema.default({
    gmail: false,
    providersoft: false,
    hubstaff: false,
    zoom: false,
    others: '',
  }),
  /** When true, skip the name soft-warn (admin confirmed a genuine namesake). */
  allowDuplicateName: z.boolean().default(false),
});
export type HireContractorInput = z.infer<typeof HireContractorSchema>;

/** Full contractor deletion — `force` clears past the signatures/documents soft-block. */
export const DeleteContractorSchema = z.object({
  workerId: z.string().uuid(),
  force: z.boolean().default(false),
});
export type DeleteContractorInput = z.infer<typeof DeleteContractorSchema>;
