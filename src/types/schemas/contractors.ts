/**
 * Zod schemas for contractor server-action trust boundaries.
 * Every contractors action validates its input with these before touching data.
 */

import { z } from 'zod';
import { uuid } from './uuid';

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

export const PayoutMethodSchema = z.enum(['wise', 'bpi', 'gcash', 'paymaya', 'paypal']);
/**
 * Contract types. FT/PT are salaried (expected-hours performance ratio). PHS
 * (per hour / session — the shared-prod model) has no expected hours and is paid
 * per unit, with `pay_basis` choosing the unit: worked hours × per-hour rate, or
 * approved sessions × per-session rate. `PH`/`PS` are this app's own LEGACY
 * per-unit types (PH ≡ PHS+hourly, PS ≡ PHS+per_session) — still read and paid,
 * but no longer offered for new engagements (see CONTRACT_OPTIONS).
 */
export const ContractTypeSchema = z.enum(['FT', 'PT', 'PH', 'PS', 'PHS']);
export type ContractType = z.infer<typeof ContractTypeSchema>;
/** PHS unit discriminator (worker_companies.pay_basis). */
export const PayBasisSchema = z.enum(['hourly', 'per_session']);
export type PayBasis = z.infer<typeof PayBasisSchema>;
/** Dropdown options (value + label), shared across the contractor UIs. Matches
 *  the originals: FT/PT/PHS. Legacy PH/PS are read but not offered for new rows. */
export const CONTRACT_OPTIONS = [
  { value: 'FT', label: 'Full-time' },
  { value: 'PT', label: 'Part-time' },
  { value: 'PHS', label: 'Per hour / session' },
] as const satisfies ReadonlyArray<{ value: ContractType; label: string }>;
/** PHS pay-basis dropdown options. */
export const PAY_BASIS_OPTIONS = [
  { value: 'hourly', label: 'Per hour' },
  { value: 'per_session', label: 'Per session' },
] as const satisfies ReadonlyArray<{ value: PayBasis; label: string }>;
/** True for the per-unit (no-expected-hours) contract types. */
export const isPerUnitContract = (c: string): boolean => c === 'PH' || c === 'PS' || c === 'PHS';
/**
 * Normalise a stored engagement for editing in a FT/PT/PHS form: legacy `PH`/`PS`
 * map to `PHS` + the equivalent pay_basis, so opening + saving an old row migrates
 * it to the shared-prod model. FT/PT/PHS pass through unchanged.
 */
export const contractForEdit = (
  contract: string,
  payBasis: string | null,
): { contract: ContractType; payBasis: PayBasis | null } => {
  if (contract === 'PH') return { contract: 'PHS', payBasis: 'hourly' };
  if (contract === 'PS') return { contract: 'PHS', payBasis: 'per_session' };
  if (contract === 'PHS') {
    const pb = payBasis === 'hourly' || payBasis === 'per_session' ? payBasis : null;
    return { contract: 'PHS', payBasis: pb };
  }
  return { contract: (contract as ContractType) || 'FT', payBasis: null };
};
export const WorkerStatusSchema = z.enum(['active', 'inactive', 'ended']);

/**
 * Require a valid pay_basis whenever the contract is PHS (per hour / session);
 * a PHS engagement with no basis is unpayable (the engine refuses to guess).
 */
const requirePayBasisForPhs = (
  v: { contract: ContractType; payBasis: PayBasis | null },
  ctx: z.RefinementCtx,
) => {
  if (v.contract === 'PHS' && v.payBasis == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payBasis'],
      message: 'Choose a pay basis (per hour or per session) for a per-hour/session contract.',
    });
  }
};

/** Create a minimal contractor (quick-add) and link to a company. */
export const AddContractorSchema = z
  .object({
    companyId: uuid(),
    firstName: z.string().min(1, 'First name required').max(80),
    lastName: z.string().min(1, 'Last name required').max(80),
    contract: ContractTypeSchema.default('FT'),
    payBasis: PayBasisSchema.nullable().default(null),
    /** Optional Hubstaff source name to set on the link immediately (used by CSV import). */
    hubstaffName: z.string().max(100).optional(),
  })
  .superRefine(requirePayBasisForPhs);
export type AddContractorInput = z.infer<typeof AddContractorSchema>;

/** Worker profile fields the admin can edit. */
export const SaveWorkerProfileSchema = z
  .object({
    workerId: uuid(),
    companyId: uuid(),
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
    // About / culture (workers.profile_extras jsonb)
    favoriteColor: z.string().max(120).nullable().optional(),
    favoriteFood: z.string().max(120).nullable().optional(),
    motto: z.string().max(280).nullable().optional(),
    // worker_companies link fields
    contract: ContractTypeSchema,
    payBasis: PayBasisSchema.nullable().default(null),
    role: z.string().max(100).nullable(),
    hubstaffName: z.string().max(100).nullable(),
    weeklyHours: z.number().min(0).max(168).nullable(),
    billRateUsd: z.number().min(0).max(100000).nullable().optional(),
    sessionRateUsd: z.number().min(0).max(100000).nullable().optional(),
    linkStatus: WorkerStatusSchema,
  })
  .superRefine(requirePayBasisForPhs);
export type SaveWorkerProfileInput = z.infer<typeof SaveWorkerProfileSchema>;

/** Deactivate/reactivate a worker's link to a company. */
export const SetLinkStatusSchema = z.object({
  workerId: uuid(),
  companyId: uuid(),
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
export const HireContractorSchema = z
  .object({
    companyId: uuid(),
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
    payBasis: PayBasisSchema.nullable().default(null),
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
    countersignerUserId: uuid().nullable().default(null),
    countersignerName: z.string().max(120).nullable().default(null),
    icAddendumType: IcAddendumTypeSchema.default(''),
    icAddendumText: z.string().max(5000).nullable().default(null),
    extraDocs: z.array(z.string().max(120)).max(20).default([]),
    // Step 2 — client invoicing (optional): assign the provider to a client and
    // set that client's USD bill rate (+ a per-session rate when enabled). These
    // attach to the client's worker_companies link, not the (employer) pay link.
    invoiceClientId: uuid().nullable().default(null),
    billRateUsd: z.number().min(0).max(100000).nullable().default(null),
    perSession: z.boolean().default(false),
    sessionRateUsd: z.number().min(0).max(100000).nullable().default(null),
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
  })
  .superRefine(requirePayBasisForPhs);
export type HireContractorInput = z.infer<typeof HireContractorSchema>;

/** Full contractor deletion — `force` clears past the signatures/documents soft-block. */
export const DeleteContractorSchema = z.object({
  workerId: uuid(),
  force: z.boolean().default(false),
});
export type DeleteContractorInput = z.infer<typeof DeleteContractorSchema>;
