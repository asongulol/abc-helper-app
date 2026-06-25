/**
 * Zod schemas for invoicing server-action trust boundaries.
 * The server always recomputes line amounts from source data — these schemas only
 * carry the *inputs* (which client, which window, markup), never money the client
 * could tamper with.
 */

import { z } from 'zod';
import { uuid } from './uuid';

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

/** Inputs to preview or generate a client invoice. */
export const PreviewInvoiceSchema = z.object({
  clientId: uuid(),
  from: IsoDateSchema,
  to: IsoDateSchema,
  markupPct: z.number().min(0).max(1000).default(0),
});
export type PreviewInvoiceInput = z.infer<typeof PreviewInvoiceSchema>;

/** Generate takes the same inputs as preview (server recomputes + persists). */
export const GenerateInvoiceSchema = PreviewInvoiceSchema;

export const InvoiceStatusSchema = z.enum(['draft', 'sent', 'paid', 'void']);

export const SetInvoiceStatusSchema = z.object({
  invoiceId: uuid(),
  status: InvoiceStatusSchema,
});
export type SetInvoiceStatusInput = z.infer<typeof SetInvoiceStatusSchema>;

/**
 * Marking an invoice paid also records the accounts-receivable receipt (how much
 * landed, when, and an optional bank/Wise reference). Amounts are USD decimals to
 * match the rest of invoicing (numeric(14,2) columns), not centavos.
 */
export const MarkInvoicePaidSchema = z.object({
  invoiceId: uuid(),
  amountReceivedUsd: z.number().min(0, 'must be ≥ 0').max(1_000_000_000),
  receivedOn: IsoDateSchema,
  paymentRef: z.string().trim().max(120).optional(),
});
export type MarkInvoicePaidInput = z.infer<typeof MarkInvoicePaidSchema>;
