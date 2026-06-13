import { z } from 'zod';

export const ReviewDocumentSchema = z.object({
  documentId: z.string().uuid(),
  decision: z.enum(['approve', 'needs_replacement', 'waive', 'defer']),
  note: z.string().optional(),
  override: z.boolean().optional(),
});

export const SetSignedDateSchema = z.object({
  documentId: z.string().uuid(),
  signedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
});

export type ReviewDocumentInput = z.infer<typeof ReviewDocumentSchema>;
export type SetSignedDateInput = z.infer<typeof SetSignedDateSchema>;
