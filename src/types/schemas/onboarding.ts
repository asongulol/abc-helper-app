import { z } from 'zod';
import { uuid } from './uuid';

export const CreatePortalLoginSchema = z.object({
  workerId: uuid(),
  email: z.string().email(),
});

export const CountersignSchema = z.object({
  workerId: uuid(),
  agreementKey: z.enum(['ic_agreement', 'non_compete', 'confidentiality_nda', 'baa']),
  signatureDataUrl: z.string().min(1),
});

export const MarkReviewedSchema = z.object({
  workerId: uuid(),
});

export type CreatePortalLoginInput = z.infer<typeof CreatePortalLoginSchema>;
export type CountersignInput = z.infer<typeof CountersignSchema>;
export type MarkReviewedInput = z.infer<typeof MarkReviewedSchema>;
