'use server';

/**
 * Documents server actions — admin-gated on-demand checks.
 *
 * `runExpiryCheckNow`  — returns the structured overdue/expiring lists for an
 *   on-demand admin view (e.g. a "Run check now" button on the Documents page).
 *
 * `runHiringReviewCheckNow` — returns the structured pending/deferred lists
 *   for an on-demand admin view (e.g. a "Check pending docs" button on the
 *   Onboarding page).
 *
 * Both actions are admin-gated via requireAdmin(). Owner scope is not required
 * because the read is non-destructive (no money, no writes).
 */

import { humanizeError } from '@/lib/errors';
import { requireAdmin } from '@/server/auth/admin';
import { runExpiryCheck, runHiringReviewCheck } from '@/server/documents/service';

export interface ActionResult<T> {
  ok: true;
  data: T;
}

export interface ActionError {
  ok: false;
  error: string;
}

export type DocumentsActionResult<T> = ActionResult<T> | ActionError;

/**
 * On-demand expiry check — returns overdue + expiring-soon lists.
 * Does NOT send an email (skipEmail=true); use the cron for that.
 */
export const runExpiryCheckNow = async (
  withinDays = 30,
): Promise<DocumentsActionResult<Awaited<ReturnType<typeof runExpiryCheck>>>> => {
  try {
    await requireAdmin();
    const result = await runExpiryCheck({ withinDays, skipEmail: true });
    return { ok: true, data: result };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err),
    };
  }
};

/**
 * On-demand hiring-review check — returns pending/deferred contractor lists.
 * Does NOT send an email (skipEmail=true); use the cron for that.
 */
export const runHiringReviewCheckNow = async (): Promise<
  DocumentsActionResult<Awaited<ReturnType<typeof runHiringReviewCheck>>>
> => {
  try {
    await requireAdmin();
    const result = await runHiringReviewCheck({ skipEmail: true });
    return { ok: true, data: result };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err),
    };
  }
};
