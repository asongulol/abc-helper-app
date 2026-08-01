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
    if (!(e.expectedHours > 0)) continue; // no target → nothing to compare against
    const worked = byWorker.get(e.workerId)?.workedHours ?? 0;
    const pto = byWorker.get(e.workerId)?.ptoHours ?? 0;
    const covered = worked + pto;
    const ratio = covered / e.expectedHours;
    const row = {
      workerId: e.workerId,
      workerName: e.workerName,
      expectedHours: e.expectedHours,
      workedHours: worked,
      ptoHours: pto,
      ratio,
    };
    if (covered <= 0) {
      gaps.push({ ...row, ratio: 0, kind: 'zero_time' });
    } else if (ratio < underThreshold) {
      gaps.push({ ...row, kind: 'under_coverage' });
    }
  }

  // Worst (lowest ratio) first — most urgent gap on top.
  return gaps.sort((a, b) => a.ratio - b.ratio);
};
