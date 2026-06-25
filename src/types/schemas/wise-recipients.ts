/**
 * Zod schemas for the contractor "Wise recipients / drift" actions
 * (legacy `persist` / `persistUuid` / `pullFromWise` / `linkLookupResult`).
 * ADR pattern: Zod at every trust boundary.
 */

import { z } from 'zod';
import { uuid } from '@/types/schemas/uuid';

/** One saved Wise recipient — identifier + label only, never bank details. */
export const WiseRecipientRefSchema = z.object({
  id: z.number().int().positive(),
  label: z.string().trim().min(1).max(200),
});
export type WiseRecipientRefInput = z.infer<typeof WiseRecipientRefSchema>;

/** Persist the saved recipients list + default recipient id (legacy `persist`). */
export const SaveWiseRecipientsSchema = z.object({
  workerId: uuid(),
  companyId: uuid(),
  recipients: z.array(WiseRecipientRefSchema).max(50),
  /** The default ("last used") recipient id, or null when the list is empty. */
  defaultId: z.number().int().positive().nullable(),
});
export type SaveWiseRecipientsInput = z.infer<typeof SaveWiseRecipientsSchema>;

/** Persist the Wise recipient UUID (legacy `persistUuid`). Empty → clears it. */
export const SaveWiseRecipientUuidSchema = z.object({
  workerId: uuid(),
  companyId: uuid(),
  /** Free-form (the Wise API never returns it; pasted from the Batch CSV). */
  recipientUuid: z.string().trim().max(100).nullable(),
});
export type SaveWiseRecipientUuidInput = z.infer<typeof SaveWiseRecipientUuidSchema>;

/** Pull a single field's value from Wise into the DB (legacy `pullFromWise`). */
export const PullFromWiseSchema = z.object({
  workerId: uuid(),
  companyId: uuid(),
  field: z.enum(['name', 'email']),
  value: z.string().trim().min(1).max(300),
});
export type PullFromWiseInput = z.infer<typeof PullFromWiseSchema>;

/** Link a looked-up Wise recipient + optionally apply its name/email
 * (legacy `linkLookupResult`). */
export const LinkWiseRecipientSchema = z.object({
  workerId: uuid(),
  companyId: uuid(),
  recipientId: z.number().int().positive(),
  name: z.string().trim().max(300).nullable(),
  email: z.string().trim().max(300).nullable(),
  applyName: z.boolean(),
  applyEmail: z.boolean(),
  /** True when the recipient came from a Wisetag contact (balance recipient). */
  fromContact: z.boolean(),
});
export type LinkWiseRecipientInput = z.infer<typeof LinkWiseRecipientSchema>;
