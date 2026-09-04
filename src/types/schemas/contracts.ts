/**
 * Zod schemas for the contract-version actions (docs/CONTRACT-VERSIONS-PLAN.md §3).
 * Every contracts action validates its input with these before touching data.
 */

import { z } from 'zod';
import { ContractTypeSchema, IcAddendumTypeSchema } from './contractors';
import { uuid } from './uuid';

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

/** The terms of a draft — everything that renders into the document. */
export const DraftContractVersionSchema = z
  .object({
    workerId: uuid(),
    companyId: uuid(),
    ratePhp: z.number().min(0, 'Rate cannot be negative.').max(10_000_000),
    position: z.string().max(100).nullable().default(null),
    employmentType: ContractTypeSchema.nullable().default(null),
    schedule: z.string().max(120).nullable().default(null),
    hoursPerWeek: z.number().int().min(0).max(168).nullable().default(null),
    startDate: IsoDateSchema,
    effectiveFrom: IsoDateSchema,
    addendumType: IcAddendumTypeSchema.default(''),
    addendumText: z.string().max(5000).nullable().default(null),
  })
  // Mirrors the table CHECK, with a message a person can act on.
  .refine((v) => v.effectiveFrom >= v.startDate, {
    message: 'Effective date cannot be before the start date.',
    path: ['effectiveFrom'],
  });
export type DraftContractVersionInput = z.infer<typeof DraftContractVersionSchema>;

export const ContractVersionRefSchema = z.object({ versionId: uuid() });

export const VoidContractVersionSchema = ContractVersionRefSchema.extend({
  reason: z.string().max(500).optional(),
});

export const EngagementRefSchema = z.object({ workerId: uuid(), companyId: uuid() });

/** The contractor's signature on a sent version (same evidence as SignAgreementSchema). */
export const SignContractVersionSchema = ContractVersionRefSchema.extend({
  /** Drawn data-URI, or '' when the contractor typed their name instead. */
  signatureDataUrl: z.string().max(1_400_000).default(''),
  typedName: z.string().trim().min(1, 'Signed legal name required.').max(200),
  /** The portal gates the button on this; the action refuses without it. */
  scrolledToEnd: z.boolean(),
});
