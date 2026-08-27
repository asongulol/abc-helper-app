/**
 * Pure coverage-gap classifier (no I/O, trivially testable).
 *
 * Given each contractor's expected hours for a period (resolved upstream from an
 * explicit coverage_targets row, or falling back to worker_companies.weekly_hours)
 * and their actual hours, flag the gaps:
 *   - zero_time       — expected to work but recorded nothing at all
 *   - under_coverage  — recorded less than `underThreshold` of expected (default 60%)
 *
 * Coverage counts tracked hours + PTO: approved leave is time the contractor was
 * accounted for, so someone on vacation for the period is covered, not a gap.
 *
 * Workers with no expected hours (no target, no weekly_hours) are not flagged —
 * there's nothing to measure against. See audit/proposals/coverage-gap-detection.md.
 */

export interface CoverageExpectation {
  workerId: string;
  workerName: string;
  /** Expected hours for the period (already scaled to the period length). */
  expectedHours: number;
}

export interface CoverageActual {
  workerId: string;
  workedHours: number;
  /** Approved leave in the period — counts toward coverage. */
  ptoHours: number;
}

export type CoverageGapKind = 'zero_time' | 'under_coverage';

/** Every state a contractor can be in, including the two that aren't gaps. */
export type CoverageStatus = CoverageGapKind | 'on_track' | 'not_measured';

/**
 * The single definition of "is this person short?" — `classifyCoverage` (which
 * feeds the Overview's gap count) and /coverage's per-row pill both read it, so
 * the page an admin lands on can't contradict the badge that sent them there.
 *
 * `not_measured` is its own state, never "on track": no target and no
 * weekly_hours means there is nothing to be short OF (#029).
 */
export const coverageStatus = (
  expectedHours: number,
  coveredHours: number,
  underThreshold = 0.6,
): CoverageStatus => {
  if (!(expectedHours > 0)) return 'not_measured';
  if (!(coveredHours > 0)) return 'zero_time';
  return coveredHours / expectedHours < underThreshold ? 'under_coverage' : 'on_track';
};

export interface CoverageGap {
  workerId: string;
  workerName: string;
  expectedHours: number;
  workedHours: number;
  ptoHours: number;
  /** (worked + PTO) / expected, in [0, 1+). */
  ratio: number;
  kind: CoverageGapKind;
}

export const classifyCoverage = (
  expectations: CoverageExpectation[],
  actuals: CoverageActual[],
  underThreshold = 0.6,
): CoverageGap[] => {
  const byWorker = new Map(actuals.map((a) => [a.workerId, a]));
  const gaps: CoverageGap[] = [];

  for (const e of expectations) {
    const worked = byWorker.get(e.workerId)?.workedHours ?? 0;
    const pto = byWorker.get(e.workerId)?.ptoHours ?? 0;
    const covered = worked + pto;
    const status = coverageStatus(e.expectedHours, covered, underThreshold);
    if (status !== 'zero_time' && status !== 'under_coverage') continue;
    gaps.push({
      workerId: e.workerId,
      workerName: e.workerName,
      expectedHours: e.expectedHours,
      workedHours: worked,
      ptoHours: pto,
      ratio: status === 'zero_time' ? 0 : covered / e.expectedHours,
      kind: status,
    });
  }

  // Worst (lowest ratio) first — most urgent gap on top.
  return gaps.sort((a, b) => a.ratio - b.ratio);
};
