import 'server-only';

/**
 * Documents orchestration service — Next.js server layer.
 *
 * Ties together DB queries, pure classifiers, and the email transport.
 * This is the Next.js equivalent of the two Supabase edge functions:
 *
 *   documents-expiry-check/index.ts
 *   hiring-docs-review-check/index.ts
 *
 * EDGE FUNCTION INTEGRATION
 * --------------------------
 * Both Deno edge functions become thin wrappers around the pure modules once
 * this refactor is in place. The migration path for each function is:
 *
 *   1. Keep the existing Deno function for cron scheduling (cron schedule stays
 *      on the deployed Deno fn — it cannot be moved to Next.js without a
 *      separate scheduler service).
 *   2. In the Deno fn, after fetching rows from the DB, import (or inline-copy)
 *      the pure classifier from:
 *        - src/lib/documents/expiry.ts   → classifyExpiry()
 *        - src/lib/documents/hiring-review.ts → classifyHiringReview()
 *   3. Replace the inline classification logic in each Deno fn with a call to
 *      the mirrored pure function. The Deno fn retains: auth gate, DB fetch,
 *      email send, JSON response.
 *   4. The email HTML template in this service and the Deno fn are intentionally
 *      kept in sync manually (both are small enough for a diff review).
 *
 * IDEMPOTENCY
 * -----------
 * Both `runExpiryCheck` and `runHiringReviewCheck` are read-only with respect
 * to the DB (they never write). Email sends are best-effort; a failed send
 * returns `{ ok: false, error }` without throwing.
 */

import { createServiceClient } from '@/db/clients/service';
import {
  fetchDocumentsForExpiryCheck,
  fetchDocumentsForHiringReview,
} from '@/db/queries/documents';
import type { ExpiryResult } from '@/lib/documents/expiry';
import { classifyExpiry } from '@/lib/documents/expiry';
import type { HiringReviewResult } from '@/lib/documents/hiring-review';
import { classifyHiringReview } from '@/lib/documents/hiring-review';
import { escapeHtml } from '@/server/email/templates';
import { sendEmail } from '@/server/email/transport';
import { env } from '@/server/env';

// ---------------------------------------------------------------------------
// Expiry check
// ---------------------------------------------------------------------------

export interface ExpiryCheckOptions {
  /** Classification window in days (default 30). */
  withinDays?: number;
  /** Override "today" for deterministic tests. */
  today?: Date;
  /** Skip sending the email digest (default false). */
  skipEmail?: boolean;
}

export interface ExpiryCheckResult extends ExpiryResult {
  withinDays: number;
  emailed: boolean;
  emailError?: string;
}

/**
 * Fetch expiring/overdue documents, classify them, and optionally send an
 * admin digest email. Returns the structured result so the caller can render
 * it in the UI (e.g. the on-demand admin action).
 *
 * Uses the service client to read across all companies (admin-scoped call).
 */
export const runExpiryCheck = async (opts: ExpiryCheckOptions = {}): Promise<ExpiryCheckResult> => {
  const withinDays = opts.withinDays ?? 30;
  const today = opts.today ?? new Date();

  const db = createServiceClient();
  const rows = await fetchDocumentsForExpiryCheck(db, today, withinDays);

  const { overdue, expiringSoon } = classifyExpiry(rows, today, withinDays);

  let emailed = false;
  let emailError: string | undefined;

  if (!opts.skipEmail && (overdue.length > 0 || expiringSoon.length > 0)) {
    const to = env.GMAIL_USER; // best available default; callers may override
    if (to) {
      const line = (e: {
        worker: string;
        company: string;
        kind: string;
        title: string;
        days: number;
        expiresOn: string;
      }): string =>
        `<li><b>${escapeHtml(e.worker)}</b>${e.company ? ` (${escapeHtml(e.company)})` : ''} — ${escapeHtml(e.kind)}` +
        `${e.title ? ` &ldquo;${escapeHtml(e.title)}&rdquo;` : ''}: ` +
        `${e.days < 0 ? `overdue ${Math.abs(e.days)}d` : `in ${e.days}d`}` +
        ` (expires ${escapeHtml(e.expiresOn)})</li>`;

      const html = `<h2>Document expiry reminder</h2>${
        overdue.length
          ? `<h3>Overdue (${overdue.length})</h3><ul>${overdue.map(line).join('')}</ul>`
          : ''
      }${
        expiringSoon.length
          ? `<h3>Expiring within ${withinDays} days (${expiringSoon.length})</h3><ul>${expiringSoon.map(line).join('')}</ul>`
          : ''
      }<p style="color:#666;font-size:12px">Open the HR &amp; Payroll app → Documents tab to renew.</p>`;

      const subject = `Document reminders: ${overdue.length} overdue, ${expiringSoon.length} expiring soon`;
      const result = await sendEmail({ to, subject, html });
      emailed = result.ok;
      if (!result.ok) emailError = result.error;
    }
  }

  return {
    withinDays,
    overdue,
    expiringSoon,
    emailed,
    ...(emailError !== undefined ? { emailError } : {}),
  };
};

// ---------------------------------------------------------------------------
// Hiring review check
// ---------------------------------------------------------------------------

export interface HiringReviewCheckOptions {
  /** Include deferred docs in the digest (default true). */
  includeDeferred?: boolean;
  /** Skip sending the email digest (default false). */
  skipEmail?: boolean;
}

export interface HiringReviewCheckResult extends HiringReviewResult {
  emailed: boolean;
  emailError?: string;
}

/**
 * Fetch onboarding docs awaiting HR review, classify them, and optionally
 * send a digest email. Returns the structured result.
 *
 * Uses the service client to read across all companies.
 */
export const runHiringReviewCheck = async (
  opts: HiringReviewCheckOptions = {},
): Promise<HiringReviewCheckResult> => {
  const includeDeferred = opts.includeDeferred !== false;

  const db = createServiceClient();
  const rows = await fetchDocumentsForHiringReview(db);

  const classification = classifyHiringReview(rows, { includeDeferred });
  const { pendingContractors, deferredContractors, pendingDocs, deferredDocs, contractors } =
    classification;

  let emailed = false;
  let emailError: string | undefined;

  if (!opts.skipEmail && (pendingDocs > 0 || deferredDocs > 0)) {
    const to = env.GMAIL_USER;
    if (to) {
      const liItems = (arr: string[]): string =>
        arr.map((x) => `<li>${escapeHtml(x)}</li>`).join('');

      const section = (
        title: string,
        list: typeof pendingContractors,
        key: 'pending' | 'deferred',
        color: string,
      ): string =>
        !list.length
          ? ''
          : `<h3 style="color:${color}">${title}</h3><ul style="margin:0 0 12px">${list
              .map(
                (c) =>
                  `<li><b>${escapeHtml(c.worker)}</b>${c.company ? ` <span style="color:#666">(${escapeHtml(c.company)})</span>` : ''}` +
                  `<ul>${liItems(c[key])}</ul></li>`,
              )
              .join('')}</ul>`;

      const html = `<h2>Hiring documents need review</h2><p>${pendingDocs} document(s) from ${pendingContractors.length} contractor(s) are waiting for HR review.</p>${section(`Waiting for review (${pendingDocs})`, pendingContractors, 'pending', '#b45309')}${
        deferredDocs
          ? section(
              `Deferred — follow up (${deferredDocs})`,
              deferredContractors,
              'deferred',
              '#3730a3',
            )
          : ''
      }<p style="color:#666;font-size:12px">Open the HR &amp; Payroll app → Hiring &amp; Onboarding to review.</p>`;

      const subject = `Hiring docs to review: ${pendingDocs} waiting${deferredDocs ? `, ${deferredDocs} follow-up` : ''}`;
      const result = await sendEmail({ to, subject, html });
      emailed = result.ok;
      if (!result.ok) emailError = result.error;
    }
  }

  return {
    pendingContractors,
    deferredContractors,
    pendingDocs,
    deferredDocs,
    contractors,
    emailed,
    ...(emailError !== undefined ? { emailError } : {}),
  };
};
