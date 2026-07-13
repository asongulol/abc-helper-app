/**
 * Session/visit query module — reads/writes for the Sessions admin screen.
 * Follows the repo convention: `server-only`, `(db, …)` first arg, throw on
 * error, return mapped camelCase rows. Sessions are recorded against the CLIENT
 * (`service_sessions.company_id` = client). The invoice-time read lives in
 * src/db/queries/invoicing.ts (`fetchClientSessions`).
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';

type Db = SupabaseClient<Database>;
type ApprovalStatus = Database['public']['Enums']['approval_status'];

export type SessionRow = {
  id: string;
  workerId: string | null;
  workerName: string;
  sessionDate: string;
  sessionType: string | null;
  units: number;
  childInitials: string | null;
  eiid: string | null;
  caseRef: string | null;
  notes: string | null;
  approval: ApprovalStatus;
};

// First + last only (middle dropped — tables read cleaner). The full legal name
// still lives on payslips / Wise, which build their names separately.
const joinName = (w: { first_name: string | null; last_name: string | null } | null): string =>
  [w?.first_name, w?.last_name].filter(Boolean).join(' ').trim();

/** Sessions for a client in [from, to] (all approval states), newest first. */
export const fetchSessionsList = async (
  db: Db,
  clientId: string,
  from: string,
  to: string,
): Promise<SessionRow[]> => {
  const { data, error } = await db
    .from('service_sessions')
    .select(
      'id, worker_id, session_date, session_type, units, child_initials, eiid, case_ref, notes, approval, workers(first_name, last_name)',
    )
    .eq('company_id', clientId)
    .gte('session_date', from)
    .lte('session_date', to)
    .order('session_date', { ascending: false });
  if (error) throw new Error(`sessions: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    workerId: r.worker_id,
    workerName: joinName(r.workers),
    sessionDate: r.session_date,
    sessionType: r.session_type,
    units: Number(r.units) || 0,
    childInitials: r.child_initials,
    eiid: r.eiid,
    caseRef: r.case_ref,
    notes: r.notes,
    approval: r.approval,
  }));
};

export type NewSession = {
  companyId: string;
  workerId: string;
  sessionDate: string;
  sessionType: string | null;
  units: number;
  childInitials: string | null;
  eiid: string | null;
  caseRef: string | null;
  notes: string | null;
  /** Defaults to 'pending' (portal/CSV). Admin entry may pass 'approved'. */
  approval?: ApprovalStatus;
};

/** Insert one session/visit row (pending unless `approval` says otherwise). */
export const insertSession = async (db: Db, row: NewSession): Promise<void> => {
  const approval = row.approval ?? 'pending';
  const { error } = await db.from('service_sessions').insert({
    company_id: row.companyId,
    worker_id: row.workerId,
    session_date: row.sessionDate,
    session_type: row.sessionType,
    units: row.units,
    child_initials: row.childInitials,
    eiid: row.eiid,
    case_ref: row.caseRef,
    notes: row.notes,
    approval,
    approved_at: approval === 'approved' ? new Date().toISOString() : null,
  });
  if (error) throw new Error(`add session: ${error.message}`);
};

/**
 * Whether a non-rejected session already exists for this worker+client+date.
 * Multiple visits/day are a legal data shape (see the `service_sessions`
 * migration comment — no natural-key unique on purpose), so callers use this
 * for a confirm-once duplicate WARN, not a hard block. Rejected rows never
 * bill, so they don't count as a duplicate.
 */
export const findSessionOnDate = async (
  db: Db,
  companyId: string,
  workerId: string,
  sessionDate: string,
): Promise<boolean> => {
  const { data, error } = await db
    .from('service_sessions')
    .select('id')
    .eq('company_id', companyId)
    .eq('worker_id', workerId)
    .eq('session_date', sessionDate)
    .neq('approval', 'rejected')
    .limit(1);
  if (error) throw new Error(`session duplicate check: ${error.message}`);
  return (data ?? []).length > 0;
};

/** Bulk-insert pending sessions (CSV import). All rows share the client company. */
export const insertSessions = async (
  db: Db,
  companyId: string,
  rows: ReadonlyArray<Omit<NewSession, 'companyId'>>,
): Promise<number> => {
  if (rows.length === 0) return 0;
  const { error } = await db.from('service_sessions').insert(
    rows.map((r) => ({
      company_id: companyId,
      worker_id: r.workerId,
      session_date: r.sessionDate,
      session_type: r.sessionType,
      units: r.units,
      child_initials: r.childInitials,
      eiid: r.eiid,
      case_ref: r.caseRef,
      notes: r.notes,
      approval: 'pending' as const,
    })),
  );
  if (error) throw new Error(`import sessions: ${error.message}`);
  return rows.length;
};

// ─── Contractor portal reads ────────────────────────────────────────────────

export type WorkerClient = { id: string; name: string };

/**
 * A contractor's active CLIENT companies — the picker options in the portal.
 * worker_companies is admin-only under RLS, so callers pass the service client
 * after verifying the portal worker.
 */
export const fetchWorkerClients = async (db: Db, workerId: string): Promise<WorkerClient[]> => {
  const { data, error } = await db
    .from('worker_companies')
    .select('company_id, companies(name, kind, status)')
    .eq('worker_id', workerId)
    .eq('status', 'active');
  if (error) throw new Error(`worker clients: ${error.message}`);
  return (data ?? [])
    .filter((r) => r.companies?.kind === 'client' && r.companies?.status === 'active')
    .map((r) => ({ id: r.company_id, name: r.companies?.name ?? '—' }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Active CLIENT companies for many workers at once (worker → assigned client[]).
 * The tracker uses this to show who each contractor bills to and to flag
 * contractors with none / multiple clients (ambiguous attribution). Service
 * client (worker_companies is admin-RLS).
 */
export const fetchWorkerClientsBatch = async (
  db: Db,
  workerIds: readonly string[],
): Promise<Map<string, WorkerClient[]>> => {
  const out = new Map<string, WorkerClient[]>();
  if (workerIds.length === 0) return out;
  const { data, error } = await db
    .from('worker_companies')
    .select('worker_id, company_id, companies(name, kind, status)')
    .in('worker_id', workerIds)
    .eq('status', 'active');
  if (error) throw new Error(`worker clients batch: ${error.message}`);
  for (const r of data ?? []) {
    if (!r.worker_id || r.companies?.kind !== 'client' || r.companies?.status !== 'active')
      continue;
    const list = out.get(r.worker_id) ?? [];
    list.push({ id: r.company_id, name: r.companies?.name ?? '—' });
    out.set(r.worker_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
};

export type PortalSessionRow = {
  id: string;
  /** CLIENT company billed (needed to scope edits/deletes and re-populate the form). */
  companyId: string;
  companyName: string;
  sessionDate: string;
  item: string | null;
  units: number;
  childInitials: string | null;
  eiid: string | null;
  approval: ApprovalStatus;
};

/** A contractor's own submitted sessions (any state), newest first. */
export const fetchWorkerSessions = async (
  db: Db,
  workerId: string,
  limit = 200,
): Promise<PortalSessionRow[]> => {
  const { data, error } = await db
    .from('service_sessions')
    .select(
      'id, company_id, session_date, session_type, units, child_initials, eiid, approval, companies(name)',
    )
    .eq('worker_id', workerId)
    .order('session_date', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`worker sessions: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    companyId: r.company_id,
    companyName: r.companies?.name ?? '—',
    sessionDate: r.session_date,
    item: r.session_type,
    units: Number(r.units) || 0,
    childInitials: r.child_initials,
    eiid: r.eiid,
    approval: r.approval,
  }));
};

export type RecentSessionRow = {
  id: string;
  /** CLIENT company billed. */
  companyId: string;
  companyName: string;
  workerId: string;
  /** First + last only (middle dropped — tables read cleaner). */
  workerName: string;
  sessionDate: string;
  item: string | null;
  units: number;
  childInitials: string | null;
  eiid: string | null;
  approval: ApprovalStatus;
  /** Set once paid (via a draft/off-cycle line) — drives the Pay vs paid label. */
  paidAt: string | null;
};

/**
 * Most-recently-CREATED sessions for a set of workers (the employer's
 * per-session contractors), newest first — the always-visible "Recently added"
 * list on Time & Approval, so a just-entered session is visible without
 * re-selecting its contractor.
 */
export const fetchRecentSessionsForWorkers = async (
  db: Db,
  workerIds: readonly string[],
  limit = 30,
): Promise<RecentSessionRow[]> => {
  if (workerIds.length === 0) return [];
  const { data, error } = await db
    .from('service_sessions')
    .select(
      'id, company_id, worker_id, session_date, session_type, units, child_initials, eiid, approval, paid_at, companies(name), workers(first_name, last_name)',
    )
    .in('worker_id', workerIds as string[])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`recent sessions: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    companyId: r.company_id,
    companyName: r.companies?.name ?? '—',
    workerId: r.worker_id ?? '',
    workerName:
      [r.workers?.first_name, r.workers?.last_name].filter(Boolean).join(' ').trim() || '—',
    sessionDate: r.session_date,
    item: r.session_type,
    units: Number(r.units) || 0,
    childInitials: r.child_initials,
    eiid: r.eiid,
    approval: r.approval,
    paidAt: r.paid_at,
  }));
};

export type UnpaidSessionRow = {
  id: string;
  /** CLIENT company the session was recorded against. */
  companyId: string;
  companyName: string;
  sessionDate: string;
  sessionType: string | null;
  units: number;
  childInitials: string | null;
  eiid: string | null;
};

/**
 * A worker's APPROVED sessions not yet paid to them (paid_at IS NULL) — the
 * off-cycle pay picker. Scoped by worker across all their clients (service
 * client, since service_sessions is CLIENT-company RLS-scoped). A session that
 * has been added to the off-cycle ledger has its paid_at stamped, so it never
 * reappears here; sessions paid through a locked normal period are likewise
 * excluded once their marker is set.
 */
export const fetchUnpaidApprovedSessions = async (
  db: Db,
  workerId: string,
  limit = 200,
): Promise<UnpaidSessionRow[]> => {
  const { data, error } = await db
    .from('service_sessions')
    .select(
      'id, company_id, session_date, session_type, units, child_initials, eiid, companies(name)',
    )
    .eq('worker_id', workerId)
    .eq('approval', 'approved')
    .is('paid_at', null)
    .order('session_date', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`unpaid sessions: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    companyId: r.company_id,
    companyName: r.companies?.name ?? '—',
    sessionDate: r.session_date,
    sessionType: r.session_type,
    units: Number(r.units) || 0,
    childInitials: r.child_initials,
    eiid: r.eiid,
  }));
};

export type SessionByIdRow = {
  id: string;
  workerId: string | null;
  sessionDate: string;
  units: number;
  approval: ApprovalStatus;
  paidAt: string | null;
};

/** Fetch sessions by id (service client) — for validating an off-cycle pick. */
export const fetchSessionsByIds = async (
  db: Db,
  ids: readonly string[],
): Promise<SessionByIdRow[]> => {
  if (ids.length === 0) return [];
  const { data, error } = await db
    .from('service_sessions')
    .select('id, worker_id, session_date, units, approval, paid_at')
    .in('id', ids);
  if (error) throw new Error(`sessions by id: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    workerId: r.worker_id,
    sessionDate: r.session_date,
    units: Number(r.units) || 0,
    approval: r.approval,
    paidAt: r.paid_at,
  }));
};

/** Set approval on a set of sessions. */
export const updateSessionsApproval = async (
  db: Db,
  ids: string[],
  status: ApprovalStatus,
): Promise<void> => {
  if (ids.length === 0) return;
  const { error } = await db.from('service_sessions').update({ approval: status }).in('id', ids);
  if (error) throw new Error(`session approval: ${error.message}`);
};

/** Delete a single session (scoped to the client for safety). */
export const deleteSession = async (db: Db, clientId: string, id: string): Promise<void> => {
  const { error } = await db
    .from('service_sessions')
    .delete()
    .eq('company_id', clientId)
    .eq('id', id);
  if (error) throw new Error(`delete session: ${error.message}`);
};

export type UpdateSessionFields = {
  sessionDate: string;
  sessionType: string | null;
  units: number;
  childInitials: string | null;
  eiid: string | null;
};

/**
 * Edit a session's fields, scoped to the client AND to `approval = 'pending'`:
 * once approved a session bills/pays, so it's frozen here (RLS would also block,
 * but the explicit filter makes the no-op intent clear and self-documenting).
 */
export const updateSessionRow = async (
  db: Db,
  clientId: string,
  id: string,
  fields: UpdateSessionFields,
): Promise<void> => {
  const { error } = await db
    .from('service_sessions')
    .update({
      session_date: fields.sessionDate,
      session_type: fields.sessionType,
      units: fields.units,
      child_initials: fields.childInitials,
      eiid: fields.eiid,
    })
    .eq('company_id', clientId)
    .eq('id', id)
    .eq('approval', 'pending');
  if (error) throw new Error(`update session: ${error.message}`);
};
