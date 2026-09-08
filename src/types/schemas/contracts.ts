/**
 * Zod schemas for the contract-version actions (docs/CONTRACT-VERSIONS-PLAN.md §3).
 * Every contracts action validates its input with these before touching data.
 */

import { z } from 'zod';
import { applyIncrease, INCREASE_METHODS, type IncreaseDetail } from '@/lib/contracts/increase';
import { PACKAGE_KINDS } from '@/lib/contracts/package';
import { ContractTypeSchema, IcAddendumTypeSchema } from './contractors';
import { uuid } from './uuid';

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

/**
 * Why a version exists (docs/CONTRACT-CHANGE-WIZARD-PLAN.md decision 2). The
 * label is what the contractor sees — on the portal and in the send email; the
 * note never leaves the admin side.
 */
export const ContractChangeReasonSchema = z.enum([
  'annual_review',
  'cola',
  'role_change',
  'rehire',
  'terms_change',
  'other',
]);
export type ContractChangeReason = z.infer<typeof ContractChangeReasonSchema>;

export const CONTRACT_CHANGE_REASON_LABEL: Record<ContractChangeReason, string> = {
  annual_review: 'Annual review',
  cola: 'Cost-of-living adjustment',
  role_change: 'Role or title change',
  rehire: 'Rehire',
  terms_change: 'Change in terms',
  other: 'Other',
};

/** How the Increase step arrived at the rate (decision 4) — history, not terms. */
export const IncreaseDetailSchema = z.object({
  method: z.enum(INCREASE_METHODS),
  value: z.number().finite(),
  from: z.number().nullable(),
  to: z.number().min(0),
  base: z.enum(['record', 'live']),
});

/**
 * The four benefit terms that ride on a version and write through to the
 * worker at countersign (decision 6). Silent in the document; records only.
 */
export const ContractBenefitsSchema = z.object({
  healthAllowance: z.boolean(),
  thirteenthMonth: z.boolean(),
  holidayPay: z.boolean(),
  ptoDaysPerYear: z.number().int().min(0).max(365),
});
export type ContractBenefits = z.infer<typeof ContractBenefitsSchema>;

/**
 * contract_versions.change_detail. `increase` is written by the wizard;
 * `overpayment` by void, when the version had already priced paid periods
 * (decision 5: a note on the profile, no clawback).
 */
export type ContractChangeDetail = {
  increase?: IncreaseDetail;
  overpayment?: {
    /** Positive = paid more than the rate still in force would have. */
    amountPhp: number;
    ratePhp: number;
    periods: string[];
    notedAt: string;
  };
};

/** The terms of a draft — everything that renders into the document, plus why. */
export const DraftContractVersionSchema = z
  .object({
    workerId: uuid(),
    companyId: uuid(),
    changeReason: ContractChangeReasonSchema,
    changeNote: z.string().trim().max(1000).nullable().default(null),
    changeDetail: z.object({ increase: IncreaseDetailSchema }).nullable().default(null),
    /** Null = the worker's flags stay as they are (legacy rows read the same way). */
    benefits: ContractBenefitsSchema.nullable().default(null),
    ratePhp: z.number().min(0, 'Rate cannot be negative.').max(10_000_000),
    position: z.string().max(100).nullable().default(null),
    employmentType: ContractTypeSchema.nullable().default(null),
    schedule: z.string().max(120).nullable().default(null),
    hoursPerWeek: z.number().int().min(0).max(168).nullable().default(null),
    startDate: IsoDateSchema,
    effectiveFrom: IsoDateSchema,
    addendumType: IcAddendumTypeSchema.default(''),
    addendumText: z.string().max(5000).nullable().default(null),
    /** Section 11.1 termination notice — the {{notice_days}} token. */
    noticeDays: z.number().int().min(1, 'Notice must be at least 1 day.').max(365).default(15),
    /** Agreements to re-sign alongside the contract (decision 8). */
    resignKinds: z
      .array(z.enum(PACKAGE_KINDS))
      .default([])
      .transform((k) => [...new Set(k)]),
  })
  // Mirrors the table CHECK, with a message a person can act on.
  .refine((v) => v.effectiveFrom >= v.startDate, {
    message: 'Effective date cannot be before the start date.',
    path: ['effectiveFrom'],
  })
  .refine((v) => v.changeReason !== 'other' || !!v.changeNote, {
    message: 'Say what the change is when the reason is Other.',
    path: ['changeNote'],
  })
  // The history line is only worth reading if it adds up to the rate stored.
  .refine(
    (v) =>
      !v.changeDetail ||
      (v.changeDetail.increase.to === v.ratePhp &&
        applyIncrease(
          v.changeDetail.increase.method,
          v.changeDetail.increase.value,
          v.changeDetail.increase.from,
        ) === v.ratePhp),
    { message: 'The increase does not add up to the rate.', path: ['changeDetail'] },
  );
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
