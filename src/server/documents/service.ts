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
import { getPortalSettings, listCompaniesFull, parseOnboardingConfig } from '@/db/queries/config';
import {
  fetchDocumentsForExpiryCheck,
  fetchDocumentsForHiringReview,
} from '@/db/queries/documents';
import { fetchCurrentTeam } from '@/db/queries/onboarding';
import { shouldSendDigestToday } from '@/lib/documents/digest-schedule';
import type { ExpiryResult } from '@/lib/documents/expiry';
import { classifyExpiry } from '@/lib/documents/expiry';
import type { HiringReviewResult } from '@/lib/documents/hiring-review';
import { classifyHiringReview } from '@/lib/documents/hiring-review';
import { digestLines } from '@/lib/onboarding/current-team';
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
  /**
   * Digest recipients (the admin's `reminders.send_to`). Empty/omitted falls
   * back to GMAIL_USER so a misconfigured list never silently drops the digest.
   */
  recipients?: string[];
}

/** One contractor's digest lines: what the admin is chasing, with the company they're engaged at. */
export interface OutstandingEntry {
  worker: string;
  company: string;
  lines: string[];
}

export interface HiringReviewCheckResult extends HiringReviewResult {
  /**
   * Contracts awaiting signature/countersign and requested documents never
   * uploaded (plan §7 decision 6) — the Current team tab's chase items, across
   * all companies, one entry per contractor.
   */
  outstanding: OutstandingEntry[];
  emailed: boolean;
  emailError?: string;
}

/**
 * The Current team queue of every company, reduced to its digest lines. Reuses
 * `fetchCurrentTeam` so the email and the tab can never disagree.
 * ponytail: N companies × 6 queries once a day; a cross-company loader if the client list grows past a dozen.
 */
const fetchOutstanding = async (
  db: ReturnType<typeof createServiceClient>,
  today: string,
): Promise<OutstandingEntry[]> => {
  const companies = await listCompaniesFull(db);
  const perCompany = await Promise.all(
    companies.map(async (c) =>
      (await fetchCurrentTeam(db, c.id, today))
        .map((r) => ({
          workerId: r.workerId,
          worker: r.workerName,
          company: c.name,
          lines: digestLines(r.items),
        }))
        .filter((r) => r.lines.length > 0),
    ),
  );
  // A contractor engaged at two companies owes the same documents once.
  const byWorker = new Map<string, OutstandingEntry>();
  for (const e of perCompany.flat()) {
    const cur = byWorker.get(e.workerId);
    if (!cur) byWorker.set(e.workerId, { worker: e.worker, company: e.company, lines: e.lines });
    else {
      cur.company += `, ${e.company}`;
      for (const l of e.lines) if (!cur.lines.includes(l)) cur.lines.push(l);
    }
  }
  return [...byWorker.values()].sort((a, b) => a.worker.localeCompare(b.worker));
};

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
  const [rows, outstanding] = await Promise.all([
    fetchDocumentsForHiringReview(db),
    fetchOutstanding(db, new Date().toISOString().slice(0, 10)),
  ]);

  const classification = classifyHiringReview(rows, { includeDeferred });
  const { pendingContractors, deferredContractors, pendingDocs, deferredDocs, contractors } =
    classification;
  const outstandingLines = outstanding.reduce((n, e) => n + e.lines.length, 0);

  let emailed = false;
  let emailError: string | undefined;

  if (!opts.skipEmail && (pendingDocs > 0 || deferredDocs > 0 || outstandingLines > 0)) {
    const configured = (opts.recipients ?? []).map((r) => r.trim()).filter(Boolean);
    const to = configured.length ? configured.join(', ') : env.GMAIL_USER;
    if (to) {
      const liItems = (arr: string[]): string =>
        arr.map((x) => `<li>${escapeHtml(x)}</li>`).join('');

      const section = (title: string, list: OutstandingEntry[], color: string): string =>
        !list.length
          ? ''
          : `<h3 style="color:${color}">${title}</h3><ul style="margin:0 0 12px">${list
              .map(
                (c) =>
                  `<li><b>${escapeHtml(c.worker)}</b>${c.company ? ` <span style="color:#666">(${escapeHtml(c.company)})</span>` : ''}` +
                  `<ul>${liItems(c.lines)}</ul></li>`,
              )
              .join('')}</ul>`;
      const entries = (list: typeof pendingContractors, key: 'pending' | 'deferred') =>
        list.map((c) => ({ worker: c.worker, company: c.company, lines: c[key] }));

      const html = `<h2>Onboarding &amp; contracts</h2>${
        pendingDocs
          ? `<p>${pendingDocs} document(s) from ${pendingContractors.length} contractor(s) are waiting for HR review.</p>`
          : ''
      }${section(`Waiting for review (${pendingDocs})`, entries(pendingContractors, 'pending'), '#b45309')}${
        deferredDocs
          ? section(
              `Deferred — follow up (${deferredDocs})`,
              entries(deferredContractors, 'deferred'),
              '#3730a3',
            )
          : ''
      }${section(`Contracts &amp; requested documents to chase (${outstandingLines})`, outstanding, '#9f1239')}<p style="color:#666;font-size:12px">Open the HR &amp; Payroll app → Onboarding &amp; contracts to review, countersign or remind.</p>`;

      const parts = [
        pendingDocs ? `${pendingDocs} waiting` : '',
        deferredDocs ? `${deferredDocs} follow-up` : '',
        outstandingLines ? `${outstandingLines} to chase` : '',
      ].filter(Boolean);
      const subject = `Onboarding & contracts: ${parts.join(', ')}`;
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
    outstanding,
    emailed,
    ...(emailError !== undefined ? { emailError } : {}),
  };
};

// ---------------------------------------------------------------------------
// Scheduled hiring-review digest (config-driven)
// ---------------------------------------------------------------------------

export interface ScheduledDigestResult {
  /** Did the digest actually run (config enabled AND today matched the frequency)? */
  ran: boolean;
  /** When `ran` is false, why it was skipped. */
  skippedReason?: 'disabled' | 'frequency';
  /** Present only when `ran` is true. */
  result?: HiringReviewCheckResult;
}

/**
 * The cron-driven entry point for the hiring-review digest. Reads the admin's
 * `reminders` config (Configuration → Onboarding) and applies it:
 *   - `enabled: false`  → skip (reason 'disabled')
 *   - `frequency`       → skip on non-matching days (reason 'frequency')
 *   - `send_to`         → digest recipients (falls back to GMAIL_USER)
 *   - `include_deferred`→ whether deferred follow-ups are included
 *
 * This is what brings the otherwise write-only `reminders` config to life; the
 * cron itself fires daily (migration 0016) and this gates which ticks email.
 */
export const runScheduledHiringReviewDigest = async (
  opts: { today?: Date } = {},
): Promise<ScheduledDigestResult> => {
  const today = opts.today ?? new Date();

  const db = createServiceClient();
  const settings = await getPortalSettings(db);
  const { reminders } = parseOnboardingConfig(settings.onboardingConfigRaw);

  if (!reminders.enabled) return { ran: false, skippedReason: 'disabled' };
  if (!shouldSendDigestToday(reminders.frequency, today)) {
    return { ran: false, skippedReason: 'frequency' };
  }

  const result = await runHiringReviewCheck({
    includeDeferred: reminders.include_deferred,
    recipients: reminders.send_to,
    skipEmail: false,
  });
  return { ran: true, result };
};
