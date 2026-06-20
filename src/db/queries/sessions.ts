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

const joinName = (
  w: {
    first_name: string | null;
    middle_name: string | null;
    last_name: string | null;
  } | null,
): string => [w?.first_name, w?.middle_name, w?.last_name].filter(Boolean).join(' ').trim();

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
      'id, worker_id, session_date, session_type, units, child_initials, eiid, case_ref, notes, approval, workers(first_name, middle_name, last_name)',
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
};

/** Insert one pending session/visit row. */
export const insertSession = async (db: Db, row: NewSession): Promise<void> => {
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
    approval: 'pending',
  });
  if (error) throw new Error(`add session: ${error.message}`);
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

export type PortalSessionRow = {
  id: string;
  companyName: string;
  sessionDate: string;
  item: string | null;
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
    .select('id, session_date, session_type, child_initials, eiid, approval, companies(name)')
    .eq('worker_id', workerId)
    .order('session_date', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`worker sessions: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    companyName: r.companies?.name ?? '—',
    sessionDate: r.session_date,
    item: r.session_type,
    childInitials: r.child_initials,
    eiid: r.eiid,
    approval: r.approval,
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
