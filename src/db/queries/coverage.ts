/**
 * Coverage query module — resolves each active contractor's expected hours for a
 * period (explicit coverage_targets override, else worker_companies.weekly_hours)
 * and their actual tracked hours, then classifies the gaps.
 *
 * Mirrors the repo convention: `server-only`, `(db, …)` first arg, throw on error.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cache } from 'react';
import type { Database } from '@/db/types';
import {
  type CoverageActual,
  type CoverageExpectation,
  type CoverageGap,
  type CoverageStatus,
  classifyCoverage,
  coverageStatus,
} from '@/lib/coverage/classify';

type Db = SupabaseClient<Database>;

const joinName = (w: { first_name: string | null; last_name: string | null } | null): string =>
  [w?.first_name, w?.last_name].filter(Boolean).join(' ').trim();

/** Inclusive day span / 7 → fractional weeks in the period (e.g. a 15-day period ≈ 2.14w). */
const weeksInPeriod = (periodStart: string, periodEnd: string): number => {
  const ms = Date.parse(periodEnd) - Date.parse(periodStart);
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return (ms / 86_400_000 + 1) / 7;
};

type TargetRow = {
  worker_id: string;
  company_id: string | null;
  period_kind: string;
  target_hours: number | null;
  effective_from: string;
  effective_to: string | null;
};

/** Pick the most specific in-period target for a worker: company-scoped beats employer-wide,
 *  then latest effective_from. Returns its period-scaled hours, or null if none applies. */
const resolveTargetHours = (rows: TargetRow[], companyId: string, weeks: number): number | null => {
  const best = rows
    .filter((r) => r.target_hours !== null)
    .sort((a, b) => {
      const spec = (a.company_id === companyId ? 0 : 1) - (b.company_id === companyId ? 0 : 1);
      if (spec !== 0) return spec;
      return a.effective_from < b.effective_from ? 1 : -1; // latest first
    })[0];
  if (!best || best.target_hours === null) return null;
  return best.period_kind === 'weekly' ? best.target_hours * weeks : best.target_hours;
};

/**
 * Expected hours per active, time-tracked contractor for the period: an effective
 * explicit target if one exists, otherwise weekly_hours × weeks. Workers with
 * neither resolve to 0 (the classifier ignores them).
 *
 * Scope is narrower than the roster below: ended workers on stale-active links and
 * anyone with no Hubstaff identity (administrators who never log time) are excluded
 * — they can only ever produce a false zero_time gap.
 */
export const fetchCoverageExpectations = async (
  db: Db,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<CoverageExpectation[]> => {
  const { data: links, error } = await db
    .from('worker_companies')
    .select('worker_id, weekly_hours, workers!inner(first_name, last_name, status)')
    .eq('company_id', companyId)
    .eq('status', 'active')
    // A link left active on an ended worker is stale, not coverage.
    .eq('workers.status', 'active')
    // Coverage is measured from Hubstaff time, so a link with no Hubstaff identity
    // can never register hours — admins and other untracked staff would sit in the
    // gap list forever as zero_time. Not measurable → not a gap.
    .or('hubstaff_user_id.not.is.null,hubstaff_name.not.is.null');
  if (error) throw new Error(`coverage roster: ${error.message}`);

  const active = (links ?? []).filter((l): l is typeof l & { worker_id: string } =>
    Boolean(l.worker_id),
  );
  if (active.length === 0) return [];

  const weeks = weeksInPeriod(periodStart, periodEnd);
  const workerIds = active.map((l) => l.worker_id);

  // Explicit targets effective in [periodStart, periodEnd], company-scoped OR employer-wide.
  const { data: targets, error: tErr } = await db
    .from('coverage_targets')
    .select('worker_id, company_id, period_kind, target_hours, effective_from, effective_to')
    .in('worker_id', workerIds)
    .or(`company_id.eq.${companyId},company_id.is.null`)
    .lte('effective_from', periodEnd)
    .or(`effective_to.is.null,effective_to.gte.${periodStart}`);
  if (tErr) throw new Error(`coverage targets: ${tErr.message}`);

  const byWorker = new Map<string, TargetRow[]>();
  for (const t of targets ?? []) {
    const arr = byWorker.get(t.worker_id) ?? [];
    arr.push(t as TargetRow);
    byWorker.set(t.worker_id, arr);
  }

  return active.map((l) => {
    const explicit = resolveTargetHours(byWorker.get(l.worker_id) ?? [], companyId, weeks);
    const fallback = l.weekly_hours === null ? 0 : Number(l.weekly_hours) * weeks;
    return {
      workerId: l.worker_id,
      workerName: joinName(l.workers) || l.worker_id,
      expectedHours: explicit ?? fallback,
    };
  });
};

/** Actual tracked hours + PTO per worker for the period — both count as coverage. */
export const fetchActualHours = async (
  db: Db,
  companyId: string,
  workerIds: string[],
  periodStart: string,
  periodEnd: string,
): Promise<CoverageActual[]> => {
  if (workerIds.length === 0) return [];
  const { data, error } = await db
    .from('time_entries')
    .select('worker_id, tracked_seconds, pto_seconds')
    .eq('company_id', companyId)
    .in('worker_id', workerIds)
    .gte('work_date', periodStart)
    .lte('work_date', periodEnd)
    .limit(100000);
  if (error) throw new Error(`coverage actuals: ${error.message}`);

  const secByWorker = new Map<string, { worked: number; pto: number }>();
  for (const r of data ?? []) {
    if (!r.worker_id) continue;
    const acc = secByWorker.get(r.worker_id) ?? { worked: 0, pto: 0 };
    acc.worked += Number(r.tracked_seconds) || 0;
    acc.pto += Number(r.pto_seconds) || 0;
    secByWorker.set(r.worker_id, acc);
  }
  return [...secByWorker.entries()].map(([workerId, s]) => ({
    workerId,
    workedHours: s.worked / 3600,
    ptoHours: s.pto / 3600,
  }));
};

export interface CoverageRosterRow {
  workerId: string;
  workerName: string;
  weeklyHours: number | null;
  /** weekly_hours × weeks in THIS period — the hours that apply when no target is set. */
  defaultHours: number | null;
  /** What the Overview actually measures this worker against; 0 = not measured. */
  expectedHours: number;
  workedHours: number;
  ptoHours: number;
  status: CoverageStatus;
  /** False when the link has no Hubstaff identity — can never log time, so never a gap. */
  tracked: boolean;
  /** The current open, company-specific semi-monthly target, if any. */
  targetId: string | null;
  targetHours: number | null;
}

/** Worst first: gaps, then thin coverage, then on-track, then the unmeasurable. */
const STATUS_ORDER: Record<CoverageStatus, number> = {
  zero_time: 0,
  under_coverage: 1,
  on_track: 2,
  not_measured: 3,
};

/**
 * The /coverage management surface: every active contractor with BOTH the knob
 * (their open semi-monthly target) and the reading it produces (expected vs
 * actual hours for `periodStart`–`periodEnd`, and the resulting status).
 *
 * The reading is not recomputed here — it reuses `fetchCoverageExpectations` and
 * `fetchActualHours`, the same two functions the Overview's gap count runs on, so
 * the page an admin reaches via "Under expected hours → Investigate" always shows
 * exactly the rows that produced that count.
 *
 * Roster scope is deliberately WIDER than the gap scope: contractors with no
 * Hubstaff identity are excluded from expectations (they can never log time) but
 * still listed here as `tracked: false`, because an admin needs to see the people
 * the gap count is silently ignoring — and may want to set their target anyway.
 */
export const fetchCoverageRoster = async (
  db: Db,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<CoverageRosterRow[]> => {
  const { data: links, error } = await db
    .from('worker_companies')
    .select('worker_id, weekly_hours, workers!inner(first_name, last_name, status)')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .eq('workers.status', 'active');
  if (error) throw new Error(`coverage roster: ${error.message}`);

  const active = (links ?? []).filter((l): l is typeof l & { worker_id: string } =>
    Boolean(l.worker_id),
  );
  if (active.length === 0) return [];

  const workerIds = active.map((l) => l.worker_id);

  const [expectations, actuals, targetsRes] = await Promise.all([
    fetchCoverageExpectations(db, companyId, periodStart, periodEnd),
    fetchActualHours(db, companyId, workerIds, periodStart, periodEnd),
    db
      .from('coverage_targets')
      .select('id, worker_id, target_hours')
      .eq('company_id', companyId)
      // Only the kind this editor writes — a weekly target's raw number would
      // otherwise be read as per-period hours and silently overwritten on Save.
      .eq('period_kind', 'semi_monthly')
      .is('effective_to', null)
      .in('worker_id', workerIds),
  ]);
  if (targetsRes.error) throw new Error(`coverage targets: ${targetsRes.error.message}`);

  const expectedBy = new Map(expectations.map((e) => [e.workerId, e.expectedHours]));
  const actualBy = new Map(actuals.map((a) => [a.workerId, a]));
  const targetBy = new Map(targetsRes.data?.map((t) => [t.worker_id, t]) ?? []);
  const weeks = weeksInPeriod(periodStart, periodEnd);

  return active
    .map((l) => {
      const t = targetBy.get(l.worker_id);
      const weeklyHours = l.weekly_hours === null ? null : Number(l.weekly_hours);
      const expectedHours = expectedBy.get(l.worker_id) ?? 0;
      const worked = actualBy.get(l.worker_id)?.workedHours ?? 0;
      const pto = actualBy.get(l.worker_id)?.ptoHours ?? 0;
      return {
        workerId: l.worker_id,
        workerName: joinName(l.workers) || l.worker_id,
        weeklyHours,
        defaultHours: weeklyHours === null ? null : weeklyHours * weeks,
        expectedHours,
        workedHours: worked,
        ptoHours: pto,
        status: coverageStatus(expectedHours, worked + pto),
        tracked: expectedBy.has(l.worker_id),
        targetId: t?.id ?? null,
        targetHours:
          t?.target_hours === null || t?.target_hours === undefined ? null : Number(t.target_hours),
      };
    })
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        (a.expectedHours > 0 ? (a.workedHours + a.ptoHours) / a.expectedHours : 0) -
          (b.expectedHours > 0 ? (b.workedHours + b.ptoHours) / b.expectedHours : 0) ||
        a.workerName.localeCompare(b.workerName),
    );
};

/**
 * End-to-end: expected vs actual → coverage gaps for the period (worst first).
 *
 * `cache()`-wrapped: /overview asks for the same period from two independently
 * streamed blocks (the queue row and the KPI tile), and the request-scoped
 * Supabase client is itself cached — so identical args mean one round-trip.
 */
export const getCoverageGaps = cache(
  async (
    db: Db,
    companyId: string,
    periodStart: string,
    periodEnd: string,
    underThreshold = 0.6,
  ): Promise<{ gaps: CoverageGap[]; measured: number }> => {
    const expectations = await fetchCoverageExpectations(db, companyId, periodStart, periodEnd);
    const expected = expectations.filter((e) => e.expectedHours > 0);
    // `measured` = contractors with an expected-hours baseline. 0 means nothing is
    // being measured — the caller must not read that as "all on track" (#029).
    if (expected.length === 0) return { gaps: [], measured: 0 };
    const actuals = await fetchActualHours(
      db,
      companyId,
      expected.map((e) => e.workerId),
      periodStart,
      periodEnd,
    );
    return { gaps: classifyCoverage(expected, actuals, underThreshold), measured: expected.length };
  },
);
