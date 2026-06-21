'use server';

/**
 * Invoicing server actions — preview, generate, set-status, void.
 * Pattern: verify admin → client-scope check → Zod validate → query module →
 * audit log. Money is always recomputed here from source data; the client only
 * supplies which client / window / markup.
 */

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/db/clients/server';
import {
  allocateInvoiceNo,
  createInvoiceWithLines,
  fetchClientRoster,
  fetchClientSessions,
  fetchEmployerCompanyId,
  fetchEmployerTrackedSeconds,
  markInvoicePaidReceipt,
  type NewInvoiceLine,
  updateInvoiceStatus,
} from '@/db/queries/invoicing';
import { computeInvoice, type InvoiceComputation } from '@/lib/invoicing/compute';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import {
  GenerateInvoiceSchema,
  MarkInvoicePaidSchema,
  PreviewInvoiceSchema,
  SetInvoiceStatusSchema,
} from '@/types/schemas/invoicing';

export type InvoicePreviewLine = {
  workerId: string;
  workerName: string;
  position: string | null;
  kind: 'hourly' | 'session';
  workedHours: number;
  billRateUsd: number;
  sessionsCount: number;
  sessionRateUsd: number;
  amountUsd: number;
};

export type InvoicePreviewResult = {
  lines: InvoicePreviewLine[];
  subtotalUsd: number;
  totalUsd: number;
  totalHours: number;
  totalSessions: number;
  markupPct: number;
  /** Names of assigned contractors with no USD bill rate (their hourly lines bill $0). */
  zeroRateNames: string[];
  /** Names of contractors with sessions but no USD session rate (their session lines bill $0). */
  zeroSessionRateNames: string[];
};

/** Recompute a client's invoice for a window from source data (roster × employer time). */
async function computeForClient(
  clientId: string,
  from: string,
  to: string,
  markupPct: number,
): Promise<{
  db: Awaited<ReturnType<typeof createServerSupabase>>;
  comp: InvoiceComputation;
}> {
  const db = await createServerSupabase();
  const employerId = await fetchEmployerCompanyId(db);
  if (!employerId) throw new Error('No employer company is configured.');
  const roster = await fetchClientRoster(db, clientId);
  const seconds = await fetchEmployerTrackedSeconds(
    db,
    employerId,
    roster.map((r) => r.workerId),
    from,
    to,
  );
  // Sessions are client-scoped (service_sessions.company_id = clientId), unlike
  // time_entries which are employer-scoped and re-attributed via the roster.
  const sessions = await fetchClientSessions(db, clientId, from, to);
  return { db, comp: computeInvoice(roster, seconds, sessions, markupPct) };
}

function toPreviewResult(comp: InvoiceComputation): InvoicePreviewResult {
  return {
    lines: comp.lines.map((l) => ({
      workerId: l.workerId,
      workerName: l.workerName,
      position: l.position,
      kind: l.kind,
      workedHours: l.workedHours,
      billRateUsd: l.billRateUsd,
      sessionsCount: l.sessionsCount,
      sessionRateUsd: l.sessionRateUsd,
      amountUsd: l.amount / 100,
    })),
    subtotalUsd: comp.subtotal / 100,
    totalUsd: comp.total / 100,
    totalHours: comp.totalHours,
    totalSessions: comp.totalSessions,
    markupPct: comp.markupPct,
    zeroRateNames: comp.lines
      .filter((l) => l.kind === 'hourly' && l.billRateUsd === 0)
      .map((l) => l.workerName),
    zeroSessionRateNames: comp.lines
      .filter((l) => l.kind === 'session' && l.sessionRateUsd === 0)
      .map((l) => l.workerName),
  };
}

/** Build a preview (no persistence). */
export async function previewInvoice(args: unknown): Promise<ActionResult<InvoicePreviewResult>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = PreviewInvoiceSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const { clientId, from, to, markupPct } = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(clientId))
    return { ok: false, error: 'No access to this client.' };
  if (from > to) return { ok: false, error: 'From date must be on or before To date.' };

  try {
    const { comp } = await computeForClient(clientId, from, to, markupPct);
    return { ok: true, data: toPreviewResult(comp) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Preview failed.',
    };
  }
}

/** Generate (persist) a draft invoice + lines from a fresh server-side recompute. */
export async function generateInvoice(
  args: unknown,
): Promise<ActionResult<{ invoiceNo: string | null }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = GenerateInvoiceSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const { clientId, from, to, markupPct } = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(clientId))
    return { ok: false, error: 'No access to this client.' };
  if (from > to) return { ok: false, error: 'From date must be on or before To date.' };

  try {
    const { db, comp } = await computeForClient(clientId, from, to, markupPct);
    if (comp.lines.length === 0)
      return {
        ok: false,
        error: 'No billable hours or sessions for this client in the window.',
      };

    const invoiceNo = await allocateInvoiceNo(db, new Date().getFullYear());
    const lines: NewInvoiceLine[] = comp.lines.map((l) => ({
      workerId: l.workerId,
      workerName: l.workerName,
      position: l.position,
      kind: l.kind,
      workedHours: l.workedHours,
      billRateUsd: l.billRateUsd,
      sessionsCount: l.kind === 'session' ? l.sessionsCount : null,
      sessionRateUsd: l.kind === 'session' ? l.sessionRateUsd : null,
      amountUsd: l.amount / 100,
    }));

    let created: { id: string; invoiceNo: string | null };
    try {
      created = await createInvoiceWithLines(
        db,
        {
          companyId: clientId,
          periodStart: from,
          periodEnd: to,
          invoiceNo,
          subtotalUsd: comp.subtotal / 100,
          totalUsd: comp.total / 100,
          markupPct: comp.markupPct,
          createdBy: admin.userId,
        },
        lines,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/one_live_per_period|duplicate key/i.test(msg))
        return {
          ok: false,
          error:
            'A live invoice already exists for this client + period — void it first to regenerate.',
        };
      throw e;
    }

    await logEvent({
      companyId: clientId,
      action: 'invoice_generated',
      entity: `Invoice ${created.invoiceNo ?? created.id}`,
      detail: {
        period: [from, to],
        subtotal_usd: comp.subtotal / 100,
        total_usd: comp.total / 100,
        lines: lines.length,
      },
    });
    revalidatePath('/invoicing');
    return { ok: true, data: { invoiceNo: created.invoiceNo } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Generate failed.',
    };
  }
}

/** Set an invoice's status (draft → sent → paid, or void). */
export async function setInvoiceStatus(args: unknown): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = SetInvoiceStatusSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const { invoiceId, status } = parsed.data;

  // Paid carries an AR receipt — that goes through markInvoicePaid, not here.
  if (status === 'paid') return { ok: false, error: 'Use markInvoicePaid to record the receipt.' };

  try {
    const db = await createServerSupabase();
    await updateInvoiceStatus(db, invoiceId, status);
    await logEvent({
      action: status === 'void' ? 'invoice_voided' : 'invoice_status',
      entity: `Invoice ${invoiceId}`,
      detail: { status },
    });
    revalidatePath('/invoicing');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Update failed.',
    };
  }
}

/** Mark an invoice paid and record its accounts-receivable receipt. */
export async function markInvoicePaid(args: unknown): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = MarkInvoicePaidSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const { invoiceId, amountReceivedUsd, receivedOn, paymentRef } = parsed.data;
  const ref = paymentRef && paymentRef.length > 0 ? paymentRef : null;

  try {
    const db = await createServerSupabase();
    // RLS scopes the update to the admin's companies; an out-of-scope id is a no-op.
    await markInvoicePaidReceipt(db, invoiceId, {
      amountReceivedUsd,
      receivedOn,
      paymentRef: ref,
    });
    await logEvent({
      action: 'invoice_paid',
      entity: `Invoice ${invoiceId}`,
      detail: { amount_received_usd: amountReceivedUsd, received_on: receivedOn, payment_ref: ref },
    });
    revalidatePath('/invoicing');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Update failed.',
    };
  }
}
