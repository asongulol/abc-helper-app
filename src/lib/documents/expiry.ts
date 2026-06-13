/**
 * Pure expiry-classification logic — NO I/O, NO server-only imports.
 *
 * Single source of truth for:
 *   - The `documents-expiry-check` Supabase edge function (thin Deno wrapper).
 *   - The Next.js Documents admin screen banner.
 *   - The `src/server/documents/service.ts` orchestration layer.
 *
 * Edge-function integration note
 * --------------------------------
 * The Deno edge fn (`documents-expiry-check/index.ts`) becomes a thin wrapper:
 *   1. Fetch raw rows from the DB (Supabase REST or supabase-js).
 *   2. Map them to `ExpiryInput[]` (same shape this module expects).
 *   3. Call `classifyExpiry(inputs, today, withinDays)` from this module
 *      (copy-paste or mirror the file — Deno cannot import from the Next app).
 *   4. Build the email digest / JSON response using the returned result.
 * The cron schedule stays on the deployed Deno function.
 *
 * PURE RULES (enforced by tests):
 *   - No `Date.now()` / `new Date()` — `today` is always injected.
 *   - No `process`, `fetch`, `Deno`, `console`, env reads, or side effects.
 *   - All sorting is stable and deterministic.
 */

// ---------------------------------------------------------------------------
// Kind labels (mirrors the edge fn KIND_LABEL map exactly)
// ---------------------------------------------------------------------------

export const EXPIRY_KIND_LABEL: Readonly<Record<string, string>> = {
  ic_agreement: 'IC Agreement',
  w8ben: 'W-8BEN',
  gov_id: 'Gov ID',
  other: 'Other',
  resume: 'Resume',
  diploma: 'Diploma',
  nbi_clearance: 'NBI Clearance',
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal document record the classifier needs. Worker must be active. */
export interface ExpiryInput {
  /** Worker full name (pre-computed by caller). */
  workerName: string;
  /** Company name (or empty string). */
  companyName: string;
  /** Raw DB kind string (e.g. 'ic_agreement'). */
  kind: string;
  /** Title / label (may be null). */
  title: string | null;
  /** ISO date string YYYY-MM-DD — required (caller must filter nulls). */
  expiresOn: string;
}

export interface ExpiryEntry {
  worker: string;
  company: string;
  /** Human-readable label (from EXPIRY_KIND_LABEL or raw kind if unmapped). */
  kind: string;
  title: string;
  expiresOn: string;
  /**
   * Whole-day offset from today (UTC).
   * days < 0  → overdue
   * days >= 0 → days until expiry
   */
  days: number;
}

export interface ExpiryResult {
  overdue: ExpiryEntry[];
  expiringSoon: ExpiryEntry[];
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Whole-day difference: ISO date string (YYYY-MM-DD) vs. today (UTC).
 * Negative = past (overdue), 0 = today, positive = future.
 *
 * Mirrors the legacy edge function's `daysUntil` verbatim.
 */
export const daysUntil = (dateStr: string, today: Date): number => {
  const d = new Date(`${dateStr}T00:00:00Z`).getTime();
  const t = new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((d - t) / 86_400_000);
};

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a list of active-worker documents into overdue vs. expiring-soon.
 *
 * @param inputs      Pre-filtered list (active workers only, expiresOn non-null).
 * @param today       Injected "now" date — no `new Date()` inside.
 * @param withinDays  Window size (default 30, matching edge fn default).
 *
 * Sorting: matches legacy edge fn — both lists are ordered by expiresOn ascending
 * (earliest first). Ties are stable relative to input order.
 */
export const classifyExpiry = (
  inputs: ExpiryInput[],
  today: Date,
  withinDays = 30,
): ExpiryResult => {
  const overdue: ExpiryEntry[] = [];
  const expiringSoon: ExpiryEntry[] = [];

  for (const doc of inputs) {
    const days = daysUntil(doc.expiresOn, today);
    const entry: ExpiryEntry = {
      worker: doc.workerName,
      company: doc.companyName,
      kind: EXPIRY_KIND_LABEL[doc.kind] ?? doc.kind,
      title: doc.title ?? '',
      expiresOn: doc.expiresOn,
      days,
    };

    if (days < 0) {
      overdue.push(entry);
    } else if (days <= withinDays) {
      expiringSoon.push(entry);
    }
    // days > withinDays → future, skip (not reported)
  }

  // Sort ascending by expiresOn (soonest / most-overdue first).
  const byDate = (a: ExpiryEntry, b: ExpiryEntry): number =>
    a.expiresOn < b.expiresOn ? -1 : a.expiresOn > b.expiresOn ? 1 : 0;

  overdue.sort(byDate);
  expiringSoon.sort(byDate);

  return { overdue, expiringSoon };
};

// ---------------------------------------------------------------------------
// Banner helper (used by the Documents page)
// ---------------------------------------------------------------------------

/**
 * Count overdue and expiring-soon docs from a full document list.
 * Designed to back the admin Documents screen banner so the threshold is
 * shared with the edge function.
 *
 * @param docs        Raw document rows (any shape with expiresOn: string | null).
 * @param today       Injected date.
 * @param withinDays  Window (default 30).
 */
export const countExpiryBanner = (
  docs: ReadonlyArray<{ expiresOn: string | null }>,
  today: Date,
  withinDays = 30,
): { overdueCount: number; expiringSoonCount: number } => {
  let overdueCount = 0;
  let expiringSoonCount = 0;

  for (const d of docs) {
    if (!d.expiresOn) continue;
    const days = daysUntil(d.expiresOn, today);
    if (days < 0) overdueCount++;
    else if (days <= withinDays) expiringSoonCount++;
  }

  return { overdueCount, expiringSoonCount };
};
