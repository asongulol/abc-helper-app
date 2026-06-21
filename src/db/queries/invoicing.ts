/**
 * Invoicing query module — client-billing reads/writes for the Invoicing screen.
 * No money math here (see src/lib/invoicing/compute.ts) and no inline business
 * logic: actions call these typed helpers, mirroring the other query modules.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';
import type { LineKind, RosterEntry, WorkerSeconds, WorkerSessions } from '@/lib/invoicing/compute';

type Db = SupabaseClient<Database>;

export type ClientOption = { id: string; name: string };

export type InvoiceListRow = {
  id: string;
  companyId: string;
  companyName: string;
  periodStart: string;
  periodEnd: string;
  invoiceNo: string | null;
  status: string;
  subtotalUsd: number;
  totalUsd: number;
  markupPct: number;
  /** Accounts-receivable receipt (null until the invoice is marked paid). */
  amountReceivedUsd: number | null;
  receivedOn: string | null;
  paymentRef: string | null;
  createdAt: string;
};

export type InvoiceLineRow = {
  workerName: string | null;
  position: string | null;
  kind: LineKind;
  workedHours: number;
  billRateUsd: number;
  sessionsCount: number | null;
  sessionRateUsd: number | null;
  amountUsd: number;
};

export type InvoiceDetail = {
  id: string;
  companyName: string;
  periodStart: string;
  periodEnd: string;
  invoiceNo: string | null;
  status: string;
  subtotalUsd: number;
  totalUsd: number;
  markupPct: number;
  lines: InvoiceLineRow[];
};

export type NewInvoiceLine = {
  workerId: string;
  workerName: string;
  position: string | null;
  kind: LineKind;
  workedHours: number;
  billRateUsd: number;
  sessionsCount: number | null;
  sessionRateUsd: number | null;
  amountUsd: number;
};

const joinName = (
  w: {
    first_name: string | null;
    middle_name: string | null;
    last_name: string | null;
  } | null,
): string => [w?.first_name, w?.middle_name, w?.last_name].filter(Boolean).join(' ').trim();

/** The single employer company — all time + payroll live here (derive, never hardcode). */
export const fetchEmployerCompany = async (
  db: Db,
): Promise<{ id: string; name: string } | null> => {
  const { data, error } = await db
    .from('companies')
    .select('id, name')
    .eq('kind', 'employer')
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`employer lookup: ${error.message}`);
  return data ? { id: data.id, name: data.name } : null;
};

export const fetchEmployerCompanyId = async (db: Db): Promise<string | null> =>
  (await fetchEmployerCompany(db))?.id ?? null;

/** Active client companies — the billing targets. */
export const fetchActiveClients = async (db: Db): Promise<ClientOption[]> => {
  const { data, error } = await db
    .from('companies')
    .select('id, name')
    .eq('kind', 'client')
    .eq('status', 'active')
    .order('name');
  if (error) throw new Error(`clients: ${error.message}`);
  return (data ?? []).map((c) => ({ id: c.id, name: c.name }));
};

/** A client's active roster + USD bill rates (the worker→client billing links). */
export const fetchClientRoster = async (db: Db, clientId: string): Promise<RosterEntry[]> => {
  const { data, error } = await db
    .from('worker_companies')
    .select('worker_id, role, bill_rate_usd, workers(first_name, middle_name, last_name)')
    .eq('company_id', clientId)
    .eq('status', 'active');
  if (error) throw new Error(`client roster: ${error.message}`);
  return (data ?? [])
    .filter((r): r is typeof r & { worker_id: string } => Boolean(r.worker_id))
    .map((r) => ({
      workerId: r.worker_id,
      workerName: joinName(r.workers),
      position: r.role,
      billRateUsd: r.bill_rate_usd === null ? null : Number(r.bill_rate_usd),
    }));
};

/**
 * Approved sessions for a client in [from, to], aggregated per worker into a
 * self-contained billing input. Sessions are recorded against the CLIENT
 * directly (`service_sessions.company_id` = clientId) and bill independently of
 * the active roster: the per-worker session rate is resolved from the
 * `worker_companies` link REGARDLESS of its status, so an approved session still
 * bills after the link is deactivated/ended. A worker with no link at all bills
 * at $0 (surfaced to the caller as a missing session rate). Only approved rows
 * bill.
 */
export const fetchClientSessions = async (
  db: Db,
  clientId: string,
  from: string,
  to: string,
): Promise<WorkerSessions[]> => {
  const { data, error } = await db
    .from('service_sessions')
    .select('worker_id, units, workers(first_name, middle_name, last_name)')
    .eq('company_id', clientId)
    .eq('approval', 'approved')
    .gte('session_date', from)
    .lte('session_date', to)
    .limit(100000);
  if (error) throw new Error(`sessions: ${error.message}`);

  // Aggregate approved units + name per worker.
  const byWorker = new Map<string, { workerName: string; count: number }>();
  for (const r of data ?? []) {
    if (!r.worker_id) continue;
    const units = Number(r.units) || 0;
    const cur = byWorker.get(r.worker_id);
    if (cur) cur.count += units;
    else byWorker.set(r.worker_id, { workerName: joinName(r.workers), count: units });
  }
  if (byWorker.size === 0) return [];

  // Resolve session rate + role from the link (ANY status) so deactivated/ended
  // links still bill. A worker with no link → no entry here → null rate/role.
  const { data: links, error: le } = await db
    .from('worker_companies')
    .select('worker_id, role, session_rate_usd')
    .eq('company_id', clientId)
    .in('worker_id', [...byWorker.keys()]);
  if (le) throw new Error(`session rates: ${le.message}`);
  const linkByWorker = new Map<string, { role: string | null; sessionRateUsd: number | null }>();
  for (const l of links ?? []) {
    if (!l.worker_id) continue;
    linkByWorker.set(l.worker_id, {
      role: l.role,
      sessionRateUsd: l.session_rate_usd === null ? null : Number(l.session_rate_usd),
    });
  }

  return [...byWorker.entries()].map(([workerId, v]) => {
    const link = linkByWorker.get(workerId);
    return {
      workerId,
      workerName: v.workerName,
      position: link?.role ?? null,
      sessionsCount: v.count,
      sessionRateUsd: link?.sessionRateUsd ?? null,
    };
  });
};

/** Employer tracked time (PTO excluded) for the given workers in [from, to]. */
export const fetchEmployerTrackedSeconds = async (
  db: Db,
  employerId: string,
  workerIds: string[],
  from: string,
  to: string,
): Promise<WorkerSeconds[]> => {
  if (workerIds.length === 0) return [];
  const { data, error } = await db
    .from('time_entries')
    .select('worker_id, tracked_seconds')
    .eq('company_id', employerId)
    .in('worker_id', workerIds)
    .gte('work_date', from)
    .lte('work_date', to)
    .limit(100000);
  if (error) throw new Error(`time: ${error.message}`);
  return (data ?? [])
    .filter((t): t is typeof t & { worker_id: string } => Boolean(t.worker_id))
    .map((t) => ({
      workerId: t.worker_id,
      trackedSeconds: Number(t.tracked_seconds) || 0,
    }));
};

/** Invoice history, newest first; optionally scoped to one client. */
export const fetchInvoices = async (db: Db, clientId?: string): Promise<InvoiceListRow[]> => {
  let q = db
    .from('invoices')
    .select(
      'id, company_id, period_start, period_end, invoice_no, status, subtotal_usd, total_usd, markup_pct, amount_received_usd, received_on, payment_ref, created_at, companies(name)',
    )
    .order('created_at', { ascending: false });
  if (clientId) q = q.eq('company_id', clientId);
  const { data, error } = await q;
  if (error) throw new Error(`invoices: ${error.message}`);
  return (data ?? []).map((i) => ({
    id: i.id,
    companyId: i.company_id,
    companyName: i.companies?.name ?? '—',
    periodStart: i.period_start,
    periodEnd: i.period_end,
    invoiceNo: i.invoice_no,
    status: i.status,
    subtotalUsd: Number(i.subtotal_usd ?? 0),
    totalUsd: Number(i.total_usd ?? 0),
    markupPct: Number(i.markup_pct ?? 0),
    amountReceivedUsd: i.amount_received_usd === null ? null : Number(i.amount_received_usd),
    receivedOn: i.received_on,
    paymentRef: i.payment_ref,
    createdAt: i.created_at,
  }));
};

/** A single invoice + its line snapshot (for the printable view). */
export const fetchInvoiceDetail = async (db: Db, id: string): Promise<InvoiceDetail | null> => {
  const { data: inv, error } = await db
    .from('invoices')
    .select(
      'id, period_start, period_end, invoice_no, status, subtotal_usd, total_usd, markup_pct, companies(name)',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`invoice: ${error.message}`);
  if (!inv) return null;
  const { data: lines, error: le } = await db
    .from('invoice_lines')
    .select(
      'worker_name, position, kind, worked_hours, bill_rate_usd, sessions_count, session_rate_usd, amount_usd',
    )
    .eq('invoice_id', id)
    .order('worker_name');
  if (le) throw new Error(`invoice lines: ${le.message}`);
  return {
    id: inv.id,
    companyName: inv.companies?.name ?? '—',
    periodStart: inv.period_start,
    periodEnd: inv.period_end,
    invoiceNo: inv.invoice_no,
    status: inv.status,
    subtotalUsd: Number(inv.subtotal_usd ?? 0),
    totalUsd: Number(inv.total_usd ?? 0),
    markupPct: Number(inv.markup_pct ?? 0),
    lines: (lines ?? []).map((l) => ({
      workerName: l.worker_name,
      position: l.position,
      kind: (l.kind === 'session' ? 'session' : 'hourly') as LineKind,
      workedHours: Number(l.worked_hours ?? 0),
      billRateUsd: Number(l.bill_rate_usd ?? 0),
      sessionsCount: l.sessions_count === null ? null : Number(l.sessions_count),
      sessionRateUsd: l.session_rate_usd === null ? null : Number(l.session_rate_usd),
      amountUsd: Number(l.amount_usd ?? 0),
    })),
  };
};

/** Sequential per-year invoice number (e.g. "2026-0007") via the DB function. */
export const allocateInvoiceNo = async (db: Db, year: number): Promise<string | null> => {
  const { data, error } = await db.rpc('allocate_invoice_no', { p_year: year });
  if (error) throw new Error(`invoice no: ${error.message}`);
  return (data as string | null) ?? null;
};

/**
 * Insert an invoice header + its line snapshot. The header insert may hit the
 * `invoices_one_live_per_period` unique index (one non-void invoice per
 * client+period) — that error is surfaced to the caller for a friendly message.
 */
export const createInvoiceWithLines = async (
  db: Db,
  header: {
    companyId: string;
    periodStart: string;
    periodEnd: string;
    invoiceNo: string | null;
    subtotalUsd: number;
    totalUsd: number;
    markupPct: number;
    createdBy: string | null;
  },
  lines: NewInvoiceLine[],
): Promise<{ id: string; invoiceNo: string | null }> => {
  const { data: inv, error } = await db
    .from('invoices')
    .insert({
      company_id: header.companyId,
      period_start: header.periodStart,
      period_end: header.periodEnd,
      invoice_no: header.invoiceNo,
      status: 'draft',
      subtotal_usd: header.subtotalUsd,
      total_usd: header.totalUsd,
      markup_pct: header.markupPct,
      currency: 'USD',
      created_by: header.createdBy,
    })
    .select('id, invoice_no')
    .single();
  if (error) throw new Error(error.message);
  if (lines.length > 0) {
    const { error: le } = await db.from('invoice_lines').insert(
      lines.map((l) => ({
        invoice_id: inv.id,
        worker_id: l.workerId,
        worker_name: l.workerName,
        position: l.position,
        kind: l.kind,
        worked_hours: l.workedHours,
        bill_rate_usd: l.billRateUsd,
        sessions_count: l.sessionsCount,
        session_rate_usd: l.sessionRateUsd,
        amount_usd: l.amountUsd,
      })),
    );
    if (le) throw new Error(`invoice lines: ${le.message}`);
  }
  return { id: inv.id, invoiceNo: inv.invoice_no };
};

export const updateInvoiceStatus = async (db: Db, id: string, status: string): Promise<void> => {
  const { error } = await db.from('invoices').update({ status }).eq('id', id);
  if (error) throw new Error(`invoice status: ${error.message}`);
};

/** Mark an invoice paid AND record its accounts-receivable receipt in one write. */
export const markInvoicePaidReceipt = async (
  db: Db,
  id: string,
  receipt: { amountReceivedUsd: number; receivedOn: string; paymentRef: string | null },
): Promise<void> => {
  const { error } = await db
    .from('invoices')
    .update({
      status: 'paid',
      amount_received_usd: receipt.amountReceivedUsd,
      received_on: receipt.receivedOn,
      payment_ref: receipt.paymentRef,
    })
    .eq('id', id);
  if (error) throw new Error(`invoice receipt: ${error.message}`);
};
