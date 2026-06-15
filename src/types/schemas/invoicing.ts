/**
 * Zod schemas for invoicing server-action trust boundaries.
 * The server always recomputes line amounts from source data — these schemas only
 * carry the *inputs* (which client, which window, markup), never money the client
 * could tamper with.
 */

import { z } from 'zod';

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

/** Inputs to preview or generate a client invoice. */
export const PreviewInvoiceSchema = z.object({
  clientId: z.string().uuid(),
  from: IsoDateSchema,
  to: IsoDateSchema,
  markupPct: z.number().min(0).max(1000).default(0),
});
export type PreviewInvoiceInput = z.infer<typeof PreviewInvoiceSchema>;

/** Generate takes the same inputs as preview (server recomputes + persists). */
export const GenerateInvoiceSchema = PreviewInvoiceSchema;

export const InvoiceStatusSchema = z.enum(['draft', 'sent', 'paid', 'void']);

export const SetInvoiceStatusSchema = z.object({
  invoiceId: z.string().uuid(),
  status: InvoiceStatusSchema,
});
export type SetInvoiceStatusInput = z.infer<typeof SetInvoiceStatusSchema>;
