/**
 * Pure types for Hubstaff time-sync logic (src/lib/hubstaff/transform.ts).
 * No server-only imports — safe to use in unit tests and the pure transform layer.
 *
 * Runtime note: the Next.js app imports these directly. The Deno edge function
 * (supabase/functions/hubstaff-sync/) should be refactored into a thin wrapper
 * that calls the same pure transform — see service.ts for the full note.
 */

// ─── Hubstaff API response shapes ────────────────────────────────────────────

/** One row from GET /v2/organizations/{org}/activities/daily */
export interface HubstaffDailyActivity {
  user_id: number;
  /** ISO date string 'YYYY-MM-DD' (UTC) */
  date: string;
  /** Seconds actively tracked (timer running) */
  tracked: number;
  /** Seconds of "overall" time (tracked + idle allowance) — used for activity % */
  overall: number;
  /** Hubstaff project id (optional — present on per-project rows) */
  project_id?: number | null;
}

/** One day entry inside a time_off_request */
export interface HubstaffTimeOffDay {
  /** ISO date string 'YYYY-MM-DD' */
  date: string;
  /** Seconds of PTO on this day */
  amount_used: number;
}

/** One item from GET /v2/organizations/{org}/time_off_requests */
export interface HubstaffTimeOffRequest {
  user_id: number;
  /** 'approved' | 'pending' | 'rejected' | etc. */
  status: string;
  time_off_request_days: HubstaffTimeOffDay[];
}

/** One item from GET /v2/users?id[]=… or GET /v2/users/{id} */
export interface HubstaffUser {
  id: number;
  name: string | null;
}

// ─── Worker-matching data (provided by the DB layer to pure transform) ────────

/** A single worker→company link row, pre-fetched from worker_companies. */
export interface WorkerLink {
  workerId: string;
  companyId: string;
  hubstaffUserId: number | null;
  hubstaffName: string | null;
  workerFirstName: string | null;
  workerLastName: string | null;
  /** True when the link status is 'ended' or the worker status is 'ended'. */
  isInactive: boolean;
}

// ─── Intermediate per-user accumulators ──────────────────────────────────────

/** Per-user, per-date tracked and overall seconds from activities/daily. */
export interface UserDayAccum {
  /** Seconds actively tracked (timer) */
  tracked: number;
  /** Seconds of "overall" (tracked + idle) — used for activity_pct */
  overall: number;
  /** Seconds of approved PTO */
  pto: number;
}

// ─── Transform output ─────────────────────────────────────────────────────────

/** One output row ready to be upserted into time_entries. */
export interface HubstaffTimeRow {
  company_id: string;
  worker_id: string;
  /** source_name: canonical label for the upsert conflict key. */
  source_name: string;
  /** ISO date string 'YYYY-MM-DD' (Asia/Manila day bucket). */
  work_date: string;
  tracked_seconds: number;
  pto_seconds: number;
  /** Rounded to integer percent; null when tracked === 0. */
  activity_pct: number | null;
  approval: 'pending';
  import_batch_id: string | null;
}

/** Summary returned by transformActivities. */
export interface TransformResult {
  rows: HubstaffTimeRow[];
  /** Hubstaff display names that could not be matched to any worker. */
  unmatched: string[];
  /** Worker ids that were matched (for callers wanting to persist stable ids). */
  matchedWorkerIds: string[];
  /**
   * Workers whose hubstaff_user_id was null but matched by name this run —
   * callers should persist the id so future runs use the stable numeric id.
   */
  idsToPersist: Array<{
    workerId: string;
    companyId: string;
    hubstaffUserId: number;
  }>;
  /**
   * F3: decided (approved/rejected) days whose freshly-pulled Hubstaff seconds
   * DIFFER from the frozen stored value. The row is intentionally NOT
   * overwritten (the decided-row invariant), but the divergence is surfaced so
   * an admin can decide whether to re-open + correct it. Empty in the common
   * case (no decided day changed).
   */
  divergences: TransformDivergence[];
}

/** A decided day whose stored seconds no longer match Hubstaff (F3). */
export interface TransformDivergence {
  workerId: string | null;
  sourceName: string;
  workDate: string;
  storedTracked: number;
  storedPto: number;
  incomingTracked: number;
  incomingPto: number;
}

// ─── Decided rows (for skip-decided logic) ────────────────────────────────────

/**
 * A minimal existing time_entry used to determine whether a row has already
 * been decided (approved / rejected) by a human, in which case the sync
 * must not overwrite it.
 */
export interface ExistingDecidedEntry {
  company_id: string;
  worker_id: string | null;
  source_name: string;
  work_date: string;
  /** 'pending' | 'approved' | 'rejected' */
  approval: string;
  /** Stored seconds — used for F3 divergence detection on decided days. */
  tracked_seconds?: number;
  pto_seconds?: number;
}
