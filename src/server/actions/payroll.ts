'use server';

/**
 * Payroll server actions — WIRED (the Phase-2 pattern-setters).
 * Flow per action: verify admin (re-verification at point of use, ADR-0004) →
 * Zod-validate input → query module / service → audit log. No inline SQL,
 * no money math here — that lives in src/lib (pure) and src/db/queries.
 */

import { createServerSupabase } from '@/db/clients/server';
import { executeRateUpsert, fetchRateHistory } from '@/db/queries/rates';
import type { RateHistoryRow } from '@/db/queries/rates';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import { type CalculateDraftResult, calculateDraft } from '@/server/payroll';
import { CalculateDraftSchema, RateSaveSchema } from '@/types/schemas/payroll';

/**
 * Effective-dated rate save (legacy `saveRate`). Same-day saves replace;
 * earlier open rates are closed; the change is audit-logged from→to.
 */
export async function saveRate(args: unknown): Promise<ActionResult<{ kind: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = RateSaveSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const result = await executeRateUpsert(db, {
      workerId: input.workerId,
      companyId: input.companyId,
      amountPhp: input.amountPhp,
      effectiveStart: input.effectiveStart,
    });
    await logEvent({
      companyId: input.companyId,
      action: 'set_rate',
      entity: input.workerId,
      detail: {
        amount_php: { from: result.priorAmountPhp, to: input.amountPhp },
        effective_start: input.effectiveStart,
        kind: result.kind,
      },
    });
    return { ok: true, data: { kind: result.kind } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Rate save failed.' };
  }
}

/** Rate history for a worker in a company (newest first). */
export async function getRateHistory(args: {
  workerId: string;
  companyId: string;
}): Promise<ActionResult<{ history: RateHistoryRow[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  try {
    const db = await createServerSupabase();
    const history = await fetchRateHistory(db, args.workerId, args.companyId);
    return { ok: true, data: { history } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Lookup failed.' };
  }
}

/**
 * Recalculate a period from tracked hours and save as DRAFT (legacy
 * `calculate`). The UI owns the destructive-recalc warning + undo snapshot;
 * the service refuses locked/paid periods.
 */
export async function calculatePeriodDraft(
  args: unknown,
): Promise<ActionResult<CalculateDraftResult>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = CalculateDraftSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const result = await calculateDraft(input);
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Calculate failed.' };
  }
}
