import { z } from 'zod';

export const UpdateOwnProfileSchema = z.record(z.string(), z.string().nullable());

export const CompleteTabSchema = z.object({
  tab: z.enum(['contact', 'personal', 'payout', 'about']),
});

/** The agreement kinds (DB `agreement_kind` enum). */
export const AgreementKindSchema = z.enum([
  'ic_agreement',
  'non_compete',
  'confidentiality_nda',
  'baa',
]);
export type AgreementKind = z.infer<typeof AgreementKindSchema>;

export const SignAgreementSchema = z.object({
  agreementKey: AgreementKindSchema,
  signatureDataUrl: z.string().min(1),
  typedName: z.string().min(1),
});

export const MoodCheckinSchema = z.object({
  mood: z.number().int().min(1).max(5),
  note: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
});

export type UpdateOwnProfileInput = z.infer<typeof UpdateOwnProfileSchema>;
export type SignAgreementInput = z.infer<typeof SignAgreementSchema>;
export type MoodCheckinInput = z.infer<typeof MoodCheckinSchema>;
