'use server';

/**
 * Session server actions — verify admin → client-scope check → Zod validate →
 * query module → audit log. Mirrors src/server/actions/time.ts. Sessions are
 * client-scoped (the company id is the CLIENT being billed). Only approved
 * sessions bill (see src/db/queries/invoicing.ts `fetchClientSessions`).
 */

import { createServerSupabase } from '@/db/clients/server';
import { fetchClientRoster } from '@/db/queries/invoicing';
import {
  deleteSession as deleteSessionRow,
  fetchSessionsList,
  insertSession,
  type SessionRow,
  updateSessionsApproval,
} from '@/db/queries/sessions';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import {
  CreateSessionSchema,
  DeleteSessionSchema,
  LoadSessionsSchema,
  SetSessionApprovalSchema,
} from '@/types/schemas/sessions';

const authGuard = async (clientId: string) => {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false as const, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(clientId)) {
    return { ok: false as const, error: 'No access to this client.' };
  }
  return { ok: true as const, admin };
};

export type ClientWorker = { workerId: string; workerName: string };

/** Load a client's active roster (for the add form) + its sessions for a window. */
export async function loadClientSessions(
  args: unknown,
): Promise<ActionResult<{ roster: ClientWorker[]; sessions: SessionRow[] }>> {
  const parsed = LoadSessionsSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { clientId, from, to } = parsed.data;
  if (from > to) return { ok: false, error: 'From date must be on or before To date.' };

  const guard = await authGuard(clientId);
  if (!guard.ok) return guard;

  try {
    const db = await createServerSupabase();
    const [roster, sessions] = await Promise.all([
      fetchClientRoster(db, clientId),
      fetchSessionsList(db, clientId, from, to),
    ]);
    return {
      ok: true,
      data: {
        roster: roster.map((r) => ({ workerId: r.workerId, workerName: r.workerName })),
        sessions,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to load sessions.' };
  }
}

/** Record one session/visit (pending). */
export async function createSession(args: unknown): Promise<ActionResult> {
  const parsed = CreateSessionSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { clientId, workerId, sessionDate, sessionType, units, caseRef, notes } = parsed.data;

  const guard = await authGuard(clientId);
  if (!guard.ok) return guard;

  try {
    const db = await createServerSupabase();
    await insertSession(db, {
      companyId: clientId,
      workerId,
      sessionDate,
      sessionType: sessionType ?? null,
      units,
      caseRef: caseRef ?? null,
      notes: notes ?? null,
    });
    await logEvent({
      companyId: clientId,
      action: 'session_created',
      entity: workerId,
      detail: { date: sessionDate, units, type: sessionType ?? null },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not add session.' };
  }
}

/** Approve / reject / reset a set of sessions. */
export async function setSessionApproval(args: unknown): Promise<ActionResult<{ count: number }>> {
  const parsed = SetSessionApprovalSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { clientId, ids, status } = parsed.data;

  const guard = await authGuard(clientId);
  if (!guard.ok) return guard;

  try {
    const db = await createServerSupabase();
    await updateSessionsApproval(db, ids, status);
    await logEvent({
      companyId: clientId,
      action: 'approve_session',
      entity: clientId,
      detail: { ids_count: ids.length, status },
    });
    return { ok: true, data: { count: ids.length } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Approval update failed.' };
  }
}

/** Delete a single session. */
export async function deleteSession(args: unknown): Promise<ActionResult> {
  const parsed = DeleteSessionSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { clientId, id } = parsed.data;

  const guard = await authGuard(clientId);
  if (!guard.ok) return guard;

  try {
    const db = await createServerSupabase();
    await deleteSessionRow(db, clientId, id);
    await logEvent({
      companyId: clientId,
      action: 'delete_session',
      entity: id,
      detail: { id },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Delete failed.' };
  }
}
