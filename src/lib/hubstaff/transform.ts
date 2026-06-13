/**
 * Pure Hubstaff transform — NO network, NO DB, NO server-only imports.
 * Safe to import in unit tests and the Next.js app alike.
 *
 * Ported faithfully from the legacy edge function
 * (abc-work-app-payroll-wis-hubstaff-app/supabase/functions/hubstaff-sync/index.ts)
 * cron_ingest / sync_ingest path (~L229-L466).
 *
 * All mapping rules exercised by tests/lib/hubstaff/transform.test.ts.
 */

import { looseKey, nameKey } from '@/lib/names';
import type {
  ExistingDecidedEntry,
  HubstaffDailyActivity,
  HubstaffTimeOffRequest,
  HubstaffUser,
  TransformResult,
  UserDayAccum,
  WorkerLink,
} from './types';

// ─── Day-bucket normalisation (Asia/Manila) ────────────────────────────────
// Hubstaff returns UTC dates on activities/daily. Since the contractor's
// "working day" is Manila time (UTC+8), a UTC midnight-to-midnight date is
// already the correct calendar day for most of the work window — but
// activities logged between 16:00 UTC and midnight UTC belong to the NEXT
// Manila calendar day. The legacy fn did not apply this shift; it trusted the
// `date` field returned by Hubstaff's daily endpoint, which is ALREADY
// bucketed to the LOCAL date of the organization. We follow the same
// convention: trust the `date` field as-is. This comment documents that
// decision so future reviewers don't second-guess it.
//
// If you need to shift raw timestamps to Manila day buckets, use:
//   const manilaDate = toManilaDate(utcMs)
// (not needed here because the Hubstaff daily endpoint does it for us).

// ─── Per-user accumulators ─────────────────────────────────────────────────

/**
 * Accumulate daily_activity rows into a nested map:
 *   userId → date → { tracked, overall, pto }
 *
 * Sums across projects — Hubstaff returns one row per user/project/date.
 */
export function accumulateActivities(
  acts: HubstaffDailyActivity[],
): Map<number, Map<string, UserDayAccum>> {
  const out = new Map<number, Map<string, UserDayAccum>>();
  for (const a of acts) {
    const uid = a.user_id;
    const day = a.date;
    if (!uid || !day) continue;
    let userMap = out.get(uid);
    if (!userMap) {
      userMap = new Map();
      out.set(uid, userMap);
    }
    const prev = userMap.get(day);
    if (prev) {
      prev.tracked += a.tracked ?? 0;
      prev.overall += a.overall ?? 0;
    } else {
      userMap.set(day, { tracked: a.tracked ?? 0, overall: a.overall ?? 0, pto: 0 });
    }
  }
  return out;
}

/**
 * Accumulate approved PTO request days into the same accum map.
 * PTO is merged in-place (same map the activity pass produced).
 * Only 'approved' requests whose dates fall within [startMs, stopMs] are counted.
 *
 * The legacy fn intentionally does NOT filter on the `paid` flag — see
 * the comment block in the legacy index.ts ~L657-L664.
 */
export function accumulatePto(
  accum: Map<number, Map<string, UserDayAccum>>,
  requests: HubstaffTimeOffRequest[],
  startMs: number,
  stopMs: number,
): void {
  for (const req of requests) {
    if (req.status !== 'approved') continue;
    const uid = req.user_id;
    if (!uid) continue;
    for (const d of req.time_off_request_days ?? []) {
      const date = d.date;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const dMs = new Date(`${date}T00:00:00Z`).getTime();
      if (dMs < startMs || dMs > stopMs) continue;
      const secs = Number(d.amount_used ?? 0);
      if (!Number.isFinite(secs) || secs <= 0) continue;

      let userMap = accum.get(uid);
      if (!userMap) {
        userMap = new Map();
        accum.set(uid, userMap);
      }
      const prev = userMap.get(date);
      if (prev) {
        prev.pto += secs;
      } else {
        userMap.set(date, { tracked: 0, overall: 0, pto: secs });
      }
    }
  }
}

// ─── Name-matching index ───────────────────────────────────────────────────

export interface WorkerMatchIndex {
  /** hubstaff_user_id → workerId */
  byId: Map<number, string>;
  /** nameKey(hubstaffName | realName) → workerId */
  byStrict: Map<string, string>;
  /** looseKey(hubstaffName | realName) → workerId */
  byLoose: Map<string, string>;
  /** workerId → WorkerLink[] (all links for that worker) */
  byWorker: Map<string, WorkerLink[]>;
}

/**
 * Build a multi-tier match index from a flat list of worker_companies links.
 *
 * Priority: numeric hubstaff_user_id → strict name key → loose name key.
 * Mirrors the legacy matchWorker function (legacy index.ts ~L341-L353).
 */
export function buildWorkerMatchIndex(links: WorkerLink[]): WorkerMatchIndex {
  const byId = new Map<number, string>();
  const byStrict = new Map<string, string>();
  const byLoose = new Map<string, string>();
  const byWorker = new Map<string, WorkerLink[]>();

  for (const l of links) {
    const existing = byWorker.get(l.workerId) ?? [];
    existing.push(l);
    byWorker.set(l.workerId, existing);

    if (l.hubstaffUserId != null && !byId.has(l.hubstaffUserId)) {
      byId.set(l.hubstaffUserId, l.workerId);
    }

    const realName = [l.workerFirstName, l.workerLastName].filter(Boolean).join(' ');
    const sources = [l.hubstaffName, realName].filter(Boolean) as string[];
    for (const src of sources) {
      const sk = nameKey(src);
      const lk = looseKey(src);
      if (sk && !byStrict.has(sk)) byStrict.set(sk, l.workerId);
      if (lk && !byLoose.has(lk)) byLoose.set(lk, l.workerId);
    }
  }

  return { byId, byStrict, byLoose, byWorker };
}

/**
 * Match a Hubstaff user to a worker id.
 * Returns null for unmatched users; the caller adds them to the unmatched set.
 */
export function matchWorker(
  uid: number,
  hubstaffName: string,
  idx: WorkerMatchIndex,
): string | null {
  return (
    idx.byId.get(uid) ??
    idx.byStrict.get(nameKey(hubstaffName)) ??
    idx.byLoose.get(looseKey(hubstaffName)) ??
    null
  );
}

// ─── Decided-entry guards ──────────────────────────────────────────────────

/**
 * Build two guard sets from existing time_entries for the sync window:
 *  - decidedBySrc:    company_id|source_name|work_date  for rows decided by source name
 *  - decidedByWorker: company_id|worker_id|work_date    for rows decided by worker id
 *
 * A row is "decided" when approval !== 'pending' (human has approved or rejected).
 * The sync must never overwrite a decided row (legacy invariant).
 */
export function buildDecidedSets(existing: ExistingDecidedEntry[]): {
  decidedBySrc: Set<string>;
  decidedByWorker: Set<string>;
} {
  const decidedBySrc = new Set<string>();
  const decidedByWorker = new Set<string>();
  for (const row of existing) {
    if (row.approval && row.approval !== 'pending') {
      decidedBySrc.add(`${row.company_id}|${row.source_name}|${row.work_date}`);
      if (row.worker_id) {
        decidedByWorker.add(`${row.company_id}|${row.worker_id}|${row.work_date}`);
      }
    }
  }
  return { decidedBySrc, decidedByWorker };
}

// ─── Canonical source_name resolution ─────────────────────────────────────

/**
 * Pick the canonical source_name for a (company, worker) pair.
 *
 * The legacy fn looked up the LAST used source_name in time_entries so that
 * the upsert hits the same (company_id, source_name, work_date) unique key
 * and doesn't create a duplicate row under a slightly different name.
 *
 * The canonical map is built by the DB layer (fetchCanonicalSourceNames) and
 * passed in here. Falls back to the Hubstaff display name when no prior row
 * exists.
 */
export function resolveSourceName(
  companyId: string,
  workerId: string,
  hubstaffDisplayName: string,
  canonical: Map<string, string>,
): string {
  return canonical.get(`${companyId}|${workerId}`) ?? hubstaffDisplayName;
}

// ─── Main transform ────────────────────────────────────────────────────────

/**
 * Transform Hubstaff API data into time_entries rows.
 *
 * @param accum           Per-user per-date accumulator (from accumulateActivities + accumulatePto).
 * @param nameById        Map from Hubstaff user_id → display name.
 * @param idx             Pre-built worker match index.
 * @param canonical       Map from "companyId|workerId" → canonical source_name in time_entries.
 * @param decided         Guard sets from buildDecidedSets.
 * @param targetCompanyId The employer company id (ALL time lands here — ADR per legacy).
 * @param days            Ordered list of 'YYYY-MM-DD' dates in the window.
 * @param importBatchId   UUID to stamp on all output rows; null for preview runs.
 */
export function transformActivities(opts: {
  accum: Map<number, Map<string, UserDayAccum>>;
  nameById: Map<number, string>;
  idx: WorkerMatchIndex;
  canonical: Map<string, string>;
  decided: { decidedBySrc: Set<string>; decidedByWorker: Set<string> };
  targetCompanyId: string;
  days: string[];
  importBatchId: string | null;
}): TransformResult {
  const { accum, nameById, idx, canonical, decided, targetCompanyId, days, importBatchId } = opts;
  const { decidedBySrc, decidedByWorker } = decided;

  const rows: TransformResult['rows'] = [];
  const unmatched = new Set<string>();
  const matchedWorkerIds = new Set<string>();
  const idsToPersist: TransformResult['idsToPersist'] = [];

  for (const [uid, dayMap] of accum) {
    const hubstaffName = nameById.get(uid) ?? `user ${uid}`;
    const workerId = matchWorker(uid, hubstaffName, idx);

    if (!workerId) {
      unmatched.add(hubstaffName);
      continue;
    }

    matchedWorkerIds.add(workerId);

    // If the link matched by name but has no hubstaff_user_id stored,
    // record for the caller to persist back (id-first on next run).
    const workerLinks = idx.byWorker.get(workerId) ?? [];
    const linkForCo = workerLinks.find((l) => l.companyId === targetCompanyId);
    if (linkForCo && linkForCo.hubstaffUserId == null) {
      idsToPersist.push({ workerId, companyId: targetCompanyId, hubstaffUserId: uid });
    }

    const src = resolveSourceName(targetCompanyId, workerId, hubstaffName, canonical);

    for (const day of days) {
      const d = dayMap.get(day);
      const tracked = d?.tracked ?? 0;
      const pto = d?.pto ?? 0;
      if (tracked === 0 && pto === 0) continue;

      // Skip rows a human has already decided.
      if (
        decidedBySrc.has(`${targetCompanyId}|${src}|${day}`) ||
        decidedByWorker.has(`${targetCompanyId}|${workerId}|${day}`)
      ) {
        continue;
      }

      const overall = d?.overall ?? 0;
      const activityPct = tracked > 0 ? Math.round((overall / tracked) * 100) : null;

      rows.push({
        company_id: targetCompanyId,
        worker_id: workerId,
        source_name: src,
        work_date: day,
        tracked_seconds: tracked,
        pto_seconds: pto,
        activity_pct: activityPct,
        approval: 'pending',
        import_batch_id: importBatchId,
      });
    }
  }

  return {
    rows,
    unmatched: [...unmatched],
    matchedWorkerIds: [...matchedWorkerIds],
    idsToPersist,
  };
}

// ─── Date-range helpers ────────────────────────────────────────────────────

/**
 * Build an ordered list of 'YYYY-MM-DD' strings for [startIso, stopIso] inclusive.
 * Both inputs are expected to be 'YYYY-MM-DD' strings.
 */
export function dateRange(startIso: string, stopIso: string): string[] {
  const days: string[] = [];
  const stopMs = new Date(`${stopIso}T00:00:00Z`).getTime();
  for (let t = new Date(`${startIso}T00:00:00Z`).getTime(); t <= stopMs; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Resolve a sync window from explicit start/stop or from a lookback-days count.
 *
 * @param opts.start        Explicit 'YYYY-MM-DD' start (overrides lookback).
 * @param opts.stop         Explicit 'YYYY-MM-DD' stop  (overrides lookback).
 * @param opts.lookbackDays Days to look back from today (clamped 0-31, default 3).
 * @param opts.today        'YYYY-MM-DD' reference for lookback (default: actual today).
 */
export function resolveWindow(opts: {
  start?: string | null;
  stop?: string | null;
  lookbackDays?: number | null;
  today?: string | null;
}): { start: string; stop: string; startMs: number; stopMs: number } {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  if (DATE_RE.test(opts.start ?? '') && DATE_RE.test(opts.stop ?? '')) {
    const start = opts.start as string;
    const stop = opts.stop as string;
    return {
      start,
      stop,
      startMs: new Date(`${start}T00:00:00Z`).getTime(),
      stopMs: new Date(`${stop}T23:59:59Z`).getTime(),
    };
  }

  const lookback = Math.max(0, Math.min(31, Number(opts.lookbackDays ?? 3)));
  const today = DATE_RE.test(opts.today ?? '')
    ? (opts.today as string)
    : new Date().toISOString().slice(0, 10);
  const stopMs = new Date(`${today}T23:59:59Z`).getTime();
  const startMs = new Date(`${today}T00:00:00Z`).getTime() - lookback * 86_400_000;
  return {
    start: new Date(startMs).toISOString().slice(0, 10),
    stop: today,
    startMs,
    stopMs,
  };
}

// ─── Re-export name helpers for edge-fn mirroring ─────────────────────────
// The Deno wrapper imports these directly (same pure logic, no duplication).
export { nameKey, looseKey } from '@/lib/names';

// Re-export user-list helpers so the service layer doesn't need to import names.ts.
export type { HubstaffUser };
