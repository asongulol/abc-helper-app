/**
 * Pure hiring-review classification logic — NO I/O, NO server-only imports.
 *
 * Single source of truth for:
 *   - The `hiring-docs-review-check` Supabase edge function (thin Deno wrapper).
 *   - The `src/server/documents/service.ts` orchestration layer.
 *
 * Edge-function integration note
 * --------------------------------
 * The Deno edge fn (`hiring-docs-review-check/index.ts`) becomes a thin wrapper:
 *   1. Fetch raw onboarding-kind document rows from the DB.
 *   2. Map them to `HiringDocInput[]`.
 *   3. Call `classifyHiringReview(inputs, opts)` from this module
 *      (copy-paste or mirror the file — Deno cannot import from the Next app).
 *   4. Build the email digest / JSON response using the returned result.
 * The cron schedule stays on the deployed Deno function.
 *
 * PURE RULES (enforced by tests):
 *   - No `Date.now()` / `new Date()` inside — callers inject dates if needed.
 *   - No `process`, `fetch`, `Deno`, `console`, env reads, or side effects.
 *   - Deterministic: same input → same output.
 */

// ---------------------------------------------------------------------------
// Onboarding document kinds (matches hiring-docs-review-check ONB_DOC_KINDS)
// ---------------------------------------------------------------------------

export const ONBOARDING_DOC_KINDS: ReadonlyArray<string> = [
  'resume',
  'diploma',
  'nbi_clearance',
  'gov_id',
];

export const HIRING_KIND_LABEL: Readonly<Record<string, string>> = {
  resume: 'Resume / CV',
  diploma: 'Diploma / TOR',
  nbi_clearance: 'NBI Clearance',
  gov_id: 'Gov ID / Passport',
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Raw document record as needed by the hiring-review classifier.
 * Caller must pre-filter to active workers and onboarding kinds only.
 */
export interface HiringDocInput {
  workerId: string;
  workerName: string;
  companyName: string;
  workerEmail: string;
  kind: string;
  /** Side label (e.g. 'front', 'back') or null. */
  side: string | null;
  reviewStatus: string;
  /** ISO timestamp — used to pick the latest doc per (worker, kind, side). */
  createdAt: string;
}

export interface HiringWorkerEntry {
  worker: string;
  company: string;
  email: string;
  pending: string[];
  deferred: string[];
}

export interface HiringReviewResult {
  pendingContractors: HiringWorkerEntry[];
  deferredContractors: HiringWorkerEntry[];
  pendingDocs: number;
  deferredDocs: number;
  /** All contractors that have at least one pending or deferred doc. */
  contractors: HiringWorkerEntry[];
}

export interface HiringReviewOptions {
  /**
   * Whether to include deferred docs in the output.
   * Mirrors `portal_settings.onboarding_config.review_notify.include_deferred`.
   * Default: true.
   */
  includeDeferred?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable label for a document kind + side. */
export const docLabel = (kind: string, side: string | null): string => {
  const base = HIRING_KIND_LABEL[kind] ?? kind;
  return side ? `${base} (${side})` : base;
};

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify onboarding documents into pending-review and deferred groups.
 *
 * Algorithm mirrors the legacy edge function exactly:
 *   1. De-duplicate to the LATEST doc per (workerId, kind, side) by createdAt.
 *   2. Skip workers whose status is not 'active' (caller must pre-filter).
 *   3. Bucket by review_status: 'pending' → pending, 'deferred' → deferred.
 *   4. Group by worker, collect doc labels per bucket.
 *   5. Sort contractors by name (localeCompare).
 *
 * @param inputs        Pre-filtered inputs (active workers, onboarding kinds).
 * @param opts          Classification options.
 */
export const classifyHiringReview = (
  inputs: HiringDocInput[],
  opts: HiringReviewOptions = {},
): HiringReviewResult => {
  const includeDeferred = opts.includeDeferred !== false;

  // Step 1: Latest doc per (workerId, kind, side).
  const latestKey = (d: HiringDocInput): string => `${d.workerId}|${d.kind}|${d.side ?? ''}`;
  const latest = new Map<string, HiringDocInput>();
  for (const d of inputs) {
    const k = latestKey(d);
    const existing = latest.get(k);
    if (!existing || d.createdAt > existing.createdAt) {
      latest.set(k, d);
    }
  }

  // Step 2+3: Bucket into pending / deferred per worker.
  const byWorker = new Map<
    string,
    { worker: string; company: string; email: string; pending: string[]; deferred: string[] }
  >();

  for (const d of latest.values()) {
    const bucket =
      d.reviewStatus === 'pending' ? 'pending' : d.reviewStatus === 'deferred' ? 'deferred' : null;
    if (!bucket) continue;
    if (bucket === 'deferred' && !includeDeferred) continue;

    const existing = byWorker.get(d.workerId);
    if (existing) {
      existing[bucket].push(docLabel(d.kind, d.side));
    } else {
      byWorker.set(d.workerId, {
        worker: d.workerName,
        company: d.companyName,
        email: d.workerEmail,
        pending: bucket === 'pending' ? [docLabel(d.kind, d.side)] : [],
        deferred: bucket === 'deferred' ? [docLabel(d.kind, d.side)] : [],
      });
    }
  }

  // Step 4+5: Sort contractors alphabetically.
  const contractors = [...byWorker.values()].sort((a, b) => a.worker.localeCompare(b.worker));

  const pendingContractors = contractors.filter((c) => c.pending.length > 0);
  const deferredContractors = contractors.filter((c) => c.deferred.length > 0);

  const pendingDocs = pendingContractors.reduce((n, c) => n + c.pending.length, 0);
  const deferredDocs = deferredContractors.reduce((n, c) => n + c.deferred.length, 0);

  return { pendingContractors, deferredContractors, pendingDocs, deferredDocs, contractors };
};
