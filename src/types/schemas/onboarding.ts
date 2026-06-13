import { z } from 'zod';

export const CreatePortalLoginSchema = z.object({
  workerId: z.string().uuid(),
  email: z.string().email(),
});

export const CountersignSchema = z.object({
  workerId: z.string().uuid(),
  agreementKey: z.enum(['ic_agreement', 'non_compete', 'confidentiality_nda', 'baa']),
  signatureDataUrl: z.string().min(1),
});

export const MarkReviewedSchema = z.object({
  workerId: z.string().uuid(),
});

export type CreatePortalLoginInput = z.infer<typeof CreatePortalLoginSchema>;
export type CountersignInput = z.infer<typeof CountersignSchema>;
export type MarkReviewedInput = z.infer<typeof MarkReviewedSchema>;
