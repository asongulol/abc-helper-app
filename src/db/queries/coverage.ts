/**
 * Coverage query module — resolves each active contractor's expected hours for a
 * period (explicit coverage_targets override, else worker_companies.weekly_hours)
 * and their actual tracked hours, then classifies the gaps.
 *
 * Mirrors the repo convention: `server-only`, `(db, …)` first arg, throw on error.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';
import {
  type CoverageExpectation,
  type CoverageGap,
  classifyCoverage,
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
 * Expected hours per active contractor for the period: an effective explicit target
 * if one exists, otherwise weekly_hours × weeks. Workers with neither resolve to 0
 * (the classifier ignores them).
 */
export const fetchCoverageExpectations = async (
  db: Db,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<CoverageExpectation[]> => {
  const { data: links, error } = await db
    .from('worker_companies')
    .select('worker_id, weekly_hours, workers(first_name, last_name)')
    .eq('company_id', companyId)
    .eq('status', 'active');
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

/** Actual tracked hours per worker for the period (PTO excluded is upstream of time_entries). */
export const fetchActualHours = async (
  db: Db,
  companyId: string,
  workerIds: string[],
  periodStart: string,
  periodEnd: string,
): Promise<{ workerId: string; workedHours: number }[]> => {
  if (workerIds.length === 0) return [];
  const { data, error } = await db
    .from('time_entries')
    .select('worker_id, tracked_seconds')
    .eq('company_id', companyId)
    .in('worker_id', workerIds)
    .gte('work_date', periodStart)
    .lte('work_date', periodEnd)
    .limit(100000);
  if (error) throw new Error(`coverage actuals: ${error.message}`);

  const secByWorker = new Map<string, number>();
  for (const r of data ?? []) {
    if (!r.worker_id) continue;
    secByWorker.set(
      r.worker_id,
      (secByWorker.get(r.worker_id) ?? 0) + (Number(r.tracked_seconds) || 0),
    );
  }
  return [...secByWorker.entries()].map(([workerId, sec]) => ({
    workerId,
    workedHours: sec / 3600,
  }));
};

export interface CoverageRosterRow {
  workerId: string;
  workerName: string;
  /** Informational fallback target (weekly_hours) when no explicit target is set. */
  weeklyHours: number | null;
  /** The current open, company-specific target for this worker, if any. */
  targetId: string | null;
  targetHours: number | null;
  periodKind: string;
}

/**
 * Active contractors for a company with their current OPEN company-specific
 * coverage target (the management surface). weekly_hours is shown as the
 * effective fallback when no explicit target exists.
 */
export const fetchCoverageRoster = async (
  db: Db,
  companyId: string,
): Promise<CoverageRosterRow[]> => {
  const { data: links, error } = await db
    .from('worker_companies')
    .select('worker_id, weekly_hours, workers(first_name, last_name)')
    .eq('company_id', companyId)
    .eq('status', 'active');
  if (error) throw new Error(`coverage roster: ${error.message}`);

  const active = (links ?? []).filter((l): l is typeof l & { worker_id: string } =>
    Boolean(l.worker_id),
  );
  if (active.length === 0) return [];

  const { data: targets, error: tErr } = await db
    .from('coverage_targets')
    .select('id, worker_id, period_kind, target_hours')
    .eq('company_id', companyId)
    .is('effective_to', null)
    .in(
      'worker_id',
      active.map((l) => l.worker_id),
    );
  if (tErr) throw new Error(`coverage targets: ${tErr.message}`);

  const byWorker = new Map(targets?.map((t) => [t.worker_id, t]) ?? []);

  return active
    .map((l) => {
      const t = byWorker.get(l.worker_id);
      return {
        workerId: l.worker_id,
        workerName: joinName(l.workers) || l.worker_id,
        weeklyHours: l.weekly_hours === null ? null : Number(l.weekly_hours),
        targetId: t?.id ?? null,
        targetHours:
          t?.target_hours === null || t?.target_hours === undefined ? null : Number(t.target_hours),
        periodKind: t?.period_kind ?? 'semi_monthly',
      };
    })
    .sort((a, b) => a.workerName.localeCompare(b.workerName));
};

/** End-to-end: expected vs actual → coverage gaps for the period (worst first). */
export const getCoverageGaps = async (
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
};
