'use server';

/**
 * Coverage-target actions — verify admin → company-scope check → Zod validate →
 * write via the RLS client (coverage_targets_admin_all double-enforces
 * is_company_admin) → audit log. Targets here OVERRIDE worker_companies.weekly_hours
 * for gap detection; clearing one falls back to weekly_hours.
 */

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/db/clients/server';
import { humanizeError } from '@/lib/errors';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import { ClearCoverageTargetSchema, SetCoverageTargetSchema } from '@/types/schemas/coverage';

const scopeOk = (admin: { isOwner: boolean; companyIds: string[] }, companyId: string): boolean =>
  admin.isOwner || admin.companyIds.includes(companyId);

/** Set (replace) a worker's open coverage target for a company. */
export async function setCoverageTarget(args: unknown): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = SetCoverageTargetSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { companyId, workerId, targetHours, periodKind } = parsed.data;
  if (!scopeOk(admin, companyId)) return { ok: false, error: 'No access to this company.' };

  try {
    const db = await createServerSupabase();
    const today = new Date().toISOString().slice(0, 10);

    // One open target per (worker, company, kind): drop the existing open row, insert the new.
    const { error: delErr } = await db
      .from('coverage_targets')
      .delete()
      .eq('company_id', companyId)
      .eq('worker_id', workerId)
      .eq('period_kind', periodKind)
      .is('effective_to', null);
    if (delErr) return { ok: false, error: `Couldn't update target: ${delErr.message}` };

    const { error: insErr } = await db.from('coverage_targets').insert({
      worker_id: workerId,
      company_id: companyId,
      period_kind: periodKind,
      target_hours: targetHours,
      effective_from: today,
      created_by: admin.userId,
    });
    if (insErr) return { ok: false, error: `Couldn't set target: ${insErr.message}` };

    await logEvent({
      companyId,
      action: 'coverage_target_set',
      entity: workerId,
      detail: { target_hours: targetHours, period_kind: periodKind },
    });
    revalidatePath('/coverage');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Update failed.') };
  }
}

/** Clear a worker's open coverage target (reverts to the weekly_hours fallback). */
export async function clearCoverageTarget(args: unknown): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = ClearCoverageTargetSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { companyId, workerId } = parsed.data;
  if (!scopeOk(admin, companyId)) return { ok: false, error: 'No access to this company.' };

  try {
    const db = await createServerSupabase();
    const { error } = await db
      .from('coverage_targets')
      .delete()
      .eq('company_id', companyId)
      .eq('worker_id', workerId)
      .is('effective_to', null);
    if (error) return { ok: false, error: `Couldn't clear target: ${error.message}` };

    await logEvent({ companyId, action: 'coverage_target_cleared', entity: workerId, detail: {} });
    revalidatePath('/coverage');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Update failed.') };
  }
}
