'use server';

/**
 * Wise payout actions — CONTRACT FILE.
 *
 * Money movement is DRAFT-ONLY (ADR-0007 / guardrails): these actions create
 * quotes and draft transfers, reconcile, and look things up. They NEVER fund.
 * Implementations live in src/server/integrations/wise.ts and are filled in by
 * the server-layer build; the signatures here are the stable contract the
 * Process & Pay screen codes against.
 */

export type WiseActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface DraftResult {
  paymentId: string;
  transferId?: number;
  fxRate?: number;
  error?: string;
}

const notWired = (): never => {
  throw new Error('Wise integration not wired yet — see src/server/integrations/wise.ts');
};

/** OWNER-only: create quote + draft transfer per payment. NO funding, ever. */
export async function wiseDraft(_paymentIds: string[]): Promise<WiseActionResult<DraftResult[]>> {
  return notWired();
}

/** OWNER-only: draft transfers inside a Wise batch group. NO funding, ever. */
export async function wiseBatch(
  _paymentIds: string[],
): Promise<WiseActionResult<{ batchGroupId: string; results: DraftResult[] }>> {
  return notWired();
}

/** Admin: server-side reconcile — flip payments to 'sent' on terminal success. */
export async function wisePoll(): Promise<WiseActionResult<{ updated: number; checked: number }>> {
  return notWired();
}

/** Admin: backfill matcher for payments missing a wise_transfer_id. */
export async function wiseMatch(_args: {
  periodStart?: string;
  periodEnd?: string;
}): Promise<WiseActionResult<{ matched: number; suggestions: unknown[] }>> {
  return notWired();
}

/** Admin: live PHP/USD mid-market rate from Wise. */
export async function wiseRates(): Promise<WiseActionResult<{ rate: number; time: string }>> {
  return notWired();
}

/** Admin: transfer status lookups for the given payments. */
export async function wiseStatus(
  _paymentIds: string[],
): Promise<WiseActionResult<{ paymentId: string; status: string; wiseStatus?: string }[]>> {
  return notWired();
}

/** Admin: recipient list / lookup for the profile panel. */
export async function wiseRecipients(): Promise<WiseActionResult<unknown[]>> {
  return notWired();
}

export async function wiseGetRecipient(_recipientId: number): Promise<WiseActionResult<unknown>> {
  return notWired();
}

export async function wiseFindTransfersByRecipient(
  _recipientId: number,
): Promise<WiseActionResult<unknown[]>> {
  return notWired();
}
