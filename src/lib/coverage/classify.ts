/**
 * Pure coverage-gap classifier (no I/O, trivially testable).
 *
 * Given each contractor's expected hours for a period (resolved upstream from an
 * explicit coverage_targets row, or falling back to worker_companies.weekly_hours)
 * and their actual tracked hours, flag the gaps:
 *   - zero_time       — expected to work but logged nothing
 *   - under_coverage  — logged less than `underThreshold` of expected (default 60%)
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
}

export type CoverageGapKind = 'zero_time' | 'under_coverage';

export interface CoverageGap {
  workerId: string;
  workerName: string;
  expectedHours: number;
  workedHours: number;
  /** worked / expected, in [0, 1+). */
  ratio: number;
  kind: CoverageGapKind;
}

export const classifyCoverage = (
  expectations: CoverageExpectation[],
  actuals: CoverageActual[],
  underThreshold = 0.6,
): CoverageGap[] => {
  const workedByWorker = new Map(actuals.map((a) => [a.workerId, a.workedHours]));
  const gaps: CoverageGap[] = [];

  for (const e of expectations) {
    if (!(e.expectedHours > 0)) continue; // no target → nothing to compare against
    const worked = workedByWorker.get(e.workerId) ?? 0;
    const ratio = worked / e.expectedHours;
    if (worked <= 0) {
      gaps.push({
        workerId: e.workerId,
        workerName: e.workerName,
        expectedHours: e.expectedHours,
        workedHours: 0,
        ratio: 0,
        kind: 'zero_time',
      });
    } else if (ratio < underThreshold) {
      gaps.push({
        workerId: e.workerId,
        workerName: e.workerName,
        expectedHours: e.expectedHours,
        workedHours: worked,
        ratio,
        kind: 'under_coverage',
      });
    }
  }

  // Worst (lowest ratio) first — most urgent gap on top.
  return gaps.sort((a, b) => a.ratio - b.ratio);
};
