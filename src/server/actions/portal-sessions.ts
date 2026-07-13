'use server';

/**
 * Contractor portal — submit Early-Intervention sessions. Follows the portal
 * write pattern (src/server/actions/portal.ts): verify the logged-in worker
 * (requireWorker) → validate → service-role insert behind a code-level gate.
 * The session is recorded as PENDING for the chosen client (which must be one
 * the contractor actively serves) and bills only after an admin approves it.
 */

import { createServiceClient } from '@/db/clients/service';
import { fetchWorkerClients, findSessionOnDate, insertSession } from '@/db/queries/sessions';
import { humanizeError } from '@/lib/errors';
import type { ActionResult } from '@/server/actions/portal-admin';
import { getCurrentWorker } from '@/server/auth/worker';
import { CreateContractorSessionSchema } from '@/types/schemas/sessions';

export async function createContractorSession(args: unknown): Promise<ActionResult> {
  const worker = await getCurrentWorker();
  if (!worker) return { ok: false, error: 'Contractor login required.' };
  // The write uses the service role (bypasses RLS), so re-enforce the same
  // onboarding gate the page and the RLS contractor_insert policy require.
  if (!worker.onboarded)
    return { ok: false, error: 'Complete onboarding before submitting sessions.' };

  const parsed = CreateContractorSessionSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { clientId, sessionDate, item, childInitials, eiid, notes, confirmDuplicate } = parsed.data;

  try {
    const svc = createServiceClient();
    // Gate: the contractor must actively serve this CLIENT. fetchWorkerClients
    // already filters to active worker_companies links where companies.kind =
    // 'client' (and the company is active) — the same set as the portal picker —
    // so this also bars submitting against the employer company.
    const clients = await fetchWorkerClients(svc, worker.workerId);
    if (!clients.some((c) => c.id === clientId))
      return { ok: false, error: 'You are not assigned to that client.' };

    if (
      !confirmDuplicate &&
      (await findSessionOnDate(svc, clientId, worker.workerId, sessionDate))
    ) {
      return {
        ok: false,
        error: 'DUPLICATE_SESSION: A session already exists for this contractor on that date.',
      };
    }

    await insertSession(svc, {
      companyId: clientId,
      workerId: worker.workerId,
      sessionDate,
      sessionType: item,
      units: 1,
      childInitials,
      eiid,
      caseRef: null,
      notes: notes ?? null,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Could not submit session.') };
  }
}
