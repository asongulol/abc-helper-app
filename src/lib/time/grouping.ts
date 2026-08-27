/**
 * Pure helpers for grouping time_entries rows by contractor for a period.
 * No I/O; takes already-fetched DB rows as input.
 */

import { periodDates, periodFor } from '@/lib/dates/periods';
import { workingDayCount } from '@/lib/pay/expected-hours';
import type { Holiday } from '@/lib/pay/holidays';

export interface TimeEntryRaw {
  id: string;
  workerId: string | null;
  sourceName: string;
  workDate: string;
  trackedSeconds: number;
  ptoSeconds: number;
  approval: 'pending' | 'approved' | 'rejected';
  importBatchId: string | null;
}

export interface ContractorPeriodRow {
  sourceName: string;
  workerId: string | null;
  entries: TimeEntryRaw[];
  trackedSeconds: number;
  ptoSeconds: number;
  totalSeconds: number;
  daysWorked: number;
  /** 'pending' | 'approved' | 'rejected' | 'mixed' */
  approvalStatus: string;
}

/** Group flat time-entry rows by source_name for a given period. */
export const groupByContractor = (entries: readonly TimeEntryRaw[]): ContractorPeriodRow[] => {
  const map = new Map<string, TimeEntryRaw[]>();
  for (const e of entries) {
    const bucket = map.get(e.sourceName);
    if (bucket) {
      bucket.push(e);
    } else {
      map.set(e.sourceName, [e]);
    }
  }

  const rows: ContractorPeriodRow[] = [];
  for (const [sourceName, es] of map) {
    const trackedSeconds = es.reduce((s, e) => s + e.trackedSeconds, 0);
    const ptoSeconds = es.reduce((s, e) => s + e.ptoSeconds, 0);
    const totalSeconds = trackedSeconds + ptoSeconds;
    const daysWorked = es.filter((e) => e.trackedSeconds > 0 || e.ptoSeconds > 0).length;

    const statuses = new Set(es.map((e) => e.approval));
    const approvalStatus = statuses.size === 1 ? ([...statuses][0] ?? 'pending') : 'mixed';

    // Take workerId from the first entry that has one.
    const workerId = es.find((e) => e.workerId !== null)?.workerId ?? null;

    rows.push({
      sourceName,
      workerId,
      entries: es,
      trackedSeconds,
      ptoSeconds,
      totalSeconds,
      daysWorked,
      approvalStatus,
    });
  }

  return rows.sort((a, b) => a.sourceName.localeCompare(b.sourceName));
};

export interface PeriodWorkers {
  start: string;
  end: string;
  workerIds: string[];
}

/**
 * Bucket entries into the pay period each day falls in, with the workers touched
 * in each. Drives the approve → Calculate transfer: one batch per period, and a
 * cross-period "all unpaid" approval legitimately spans several.
 *
 * Entries with no worker_id are dropped — an unmatched import name has nobody to
 * pay until it's linked on the review table.
 */
export const groupWorkersByPeriod = (
  entries: readonly { workerId: string | null; workDate: string }[],
): PeriodWorkers[] => {
  const byPeriod = new Map<string, { start: string; end: string; workerIds: Set<string> }>();
  for (const e of entries) {
    if (!e.workerId) continue;
    const { start, end } = periodFor(e.workDate);
    const key = `${start}|${end}`;
    const bucket = byPeriod.get(key) ?? { start, end, workerIds: new Set<string>() };
    bucket.workerIds.add(e.workerId);
    byPeriod.set(key, bucket);
  }
  return [...byPeriod.values()]
    .map((b) => ({ start: b.start, end: b.end, workerIds: [...b.workerIds] }))
    .sort((a, b) => a.start.localeCompare(b.start));
};

/**
 * Derive period stats used in the header. `workingDays` excludes observed
 * holidays, so it matches the expected hours payroll actually pays; pass the
 * company's resolved holidays or the code defaults apply.
 */
export const periodStats = (
  start: string,
  end: string,
  holidays?: readonly Holiday[],
): { periodDays: number; workingDays: number } => ({
  periodDays: periodDates(start, end).length,
  workingDays: workingDayCount(start, end, holidays),
});
