/**
 * Pure helpers for grouping time_entries rows by contractor for a period.
 * No I/O; takes already-fetched DB rows as input.
 */

import { periodDates, weekdayCount } from '@/lib/dates/periods';

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

/** Derive period stats used in the header. */
export const periodStats = (
  start: string,
  end: string,
): { periodDays: number; workingDays: number } => {
  const dates = periodDates(start, end);
  return {
    periodDays: dates.length,
    workingDays: weekdayCount(start, end),
  };
};
