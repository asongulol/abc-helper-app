/**
 * Unit tests for the pure Hubstaff transform (src/lib/hubstaff/transform.ts).
 *
 * Rule → test mapping:
 *
 *  accumulation across projects (same day, multi-project)
 *    → 'accumulateActivities sums tracked+overall across multiple projects for same user/day'
 *
 *  Asia/Manila day bucket — date field trusted as-is from Hubstaff daily endpoint
 *    → 'accumulateActivities preserves the date string returned by Hubstaff'
 *
 *  PTO: only approved requests count
 *    → 'accumulatePto skips non-approved requests'
 *
 *  PTO: paid flag ignored (all approved = counted)
 *    → 'accumulatePto counts approved PTO regardless of paid flag'
 *
 *  PTO: date range filter
 *    → 'accumulatePto filters PTO days outside the sync window'
 *
 *  PTO: multi-day request
 *    → 'accumulatePto accumulates multiple days from a single request'
 *
 *  worker match: numeric id wins over name
 *    → 'matchWorker prefers hubstaff_user_id over name match'
 *
 *  worker match: strict name key (sorted tokens, accent-stripped)
 *    → 'matchWorker strict name key matches accent-stripped, order-insensitive'
 *
 *  worker match: loose name key (first+last only)
 *    → 'matchWorker loose name key matches with extra middle token'
 *
 *  worker match: no match → unmatched set
 *    → 'transformActivities adds unmatched Hubstaff names to unmatched list'
 *
 *  decided-row guard: approved row skipped
 *    → 'buildDecidedSets + transformActivities skips rows with approval=approved'
 *
 *  decided-row guard: rejected row skipped
 *    → 'buildDecidedSets + transformActivities skips rows with approval=rejected'
 *
 *  decided-row guard: pending row NOT skipped
 *    → 'buildDecidedSets + transformActivities keeps rows with approval=pending'
 *
 *  canonical source_name used when prior entry exists
 *    → 'transformActivities resolves canonical source_name from prior time_entries'
 *
 *  activity_pct computed as round(overall/tracked*100)
 *    → 'transformActivities computes activity_pct correctly'
 *
 *  activity_pct = null when tracked === 0 (PTO-only day)
 *    → 'transformActivities sets activity_pct null on PTO-only days'
 *
 *  idsToPersist populated when match was by name (hubstaff_user_id was null)
 *    → 'transformActivities records idsToPersist for name-matched links'
 *
 *  dateRange: inclusive both ends
 *    → 'dateRange returns inclusive ordered dates'
 *
 *  dateRange: single day
 *    → 'dateRange returns a single-element array for same start and stop'
 *
 *  resolveWindow: explicit start/stop used when both present
 *    → 'resolveWindow uses explicit start/stop when provided'
 *
 *  resolveWindow: lookback fallback
 *    → 'resolveWindow computes lookback window from today'
 *
 *  timezone boundary: two activities same user same Manila date sum correctly
 *    → 'accumulateActivities sums activities that share the same date field'
 *
 *  member name normalisation: "Ma" → "Maria", suffix stripping
 *    → 'matchWorker resolves "Ma Dela Cruz Jr" via nameKey normalisation'
 */

import { describe, expect, it } from 'vitest';
import {
  accumulateActivities,
  accumulatePto,
  buildDecidedSets,
  buildWorkerMatchIndex,
  dateRange,
  matchWorker,
  resolveWindow,
  transformActivities,
} from '@/lib/hubstaff/transform';
import type {
  ExistingDecidedEntry,
  HubstaffDailyActivity,
  HubstaffTimeOffRequest,
  WorkerLink,
} from '@/lib/hubstaff/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeActivity(
  userId: number,
  date: string,
  tracked: number,
  overall: number,
  projectId?: number,
): HubstaffDailyActivity {
  return {
    user_id: userId,
    date,
    tracked,
    overall,
    ...(projectId !== undefined ? { project_id: projectId } : {}),
  };
}

function makeLink(
  workerId: string,
  companyId: string,
  opts: {
    hubstaffUserId?: number | null;
    hubstaffName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    isInactive?: boolean;
  } = {},
): WorkerLink {
  return {
    workerId,
    companyId,
    hubstaffUserId: opts.hubstaffUserId ?? null,
    hubstaffName: opts.hubstaffName ?? null,
    workerFirstName: opts.firstName ?? null,
    workerLastName: opts.lastName ?? null,
    isInactive: opts.isInactive ?? false,
  };
}

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const WORKER_ID_A = 'bbbbbbbb-0000-0000-0000-000000000001';
const WORKER_ID_B = 'bbbbbbbb-0000-0000-0000-000000000002';

// ─── accumulateActivities ─────────────────────────────────────────────────────

describe('accumulateActivities', () => {
  it('sums tracked+overall across multiple projects for same user/day', () => {
    const acts: HubstaffDailyActivity[] = [
      makeActivity(1, '2026-06-01', 3600, 4000, 10),
      makeActivity(1, '2026-06-01', 1800, 2000, 11),
    ];
    const result = accumulateActivities(acts);
    const day = result.get(1)?.get('2026-06-01');
    expect(day?.tracked).toBe(5400);
    expect(day?.overall).toBe(6000);
  });

  it('preserves the date string returned by Hubstaff (no timezone shift)', () => {
    const acts: HubstaffDailyActivity[] = [makeActivity(1, '2026-06-15', 3600, 3600)];
    const result = accumulateActivities(acts);
    expect(result.get(1)?.has('2026-06-15')).toBe(true);
  });

  it('sums activities that share the same date field (timezone boundary)', () => {
    // Two separate calls on the same date (e.g. morning and late afternoon Manila)
    // both arrive with the same date from Hubstaff's daily endpoint.
    const acts: HubstaffDailyActivity[] = [
      makeActivity(5, '2026-06-10', 14400, 15000),
      makeActivity(5, '2026-06-10', 7200, 7500),
    ];
    const result = accumulateActivities(acts);
    expect(result.get(5)?.get('2026-06-10')?.tracked).toBe(21600);
    expect(result.get(5)?.get('2026-06-10')?.overall).toBe(22500);
  });

  it('keeps different dates separate', () => {
    const acts: HubstaffDailyActivity[] = [
      makeActivity(1, '2026-06-01', 3600, 3600),
      makeActivity(1, '2026-06-02', 7200, 7200),
    ];
    const result = accumulateActivities(acts);
    expect(result.get(1)?.size).toBe(2);
  });

  it('ignores rows with missing user_id or date', () => {
    const acts = [
      { user_id: 0, date: '2026-06-01', tracked: 3600, overall: 3600 },
      { user_id: 1, date: '', tracked: 3600, overall: 3600 },
    ] as HubstaffDailyActivity[];
    const result = accumulateActivities(acts);
    expect(result.size).toBe(0);
  });
});

// ─── accumulatePto ────────────────────────────────────────────────────────────

const START_MS = new Date('2026-06-01T00:00:00Z').getTime();
const STOP_MS = new Date('2026-06-15T23:59:59Z').getTime();

describe('accumulatePto', () => {
  it('skips non-approved requests', () => {
    const req: HubstaffTimeOffRequest = {
      user_id: 1,
      status: 'pending',
      time_off_request_days: [{ date: '2026-06-05', amount_used: 28800 }],
    };
    const accum = accumulateActivities([]);
    accumulatePto(accum, [req], START_MS, STOP_MS);
    expect(accum.size).toBe(0);
  });

  it('counts approved PTO regardless of (hypothetical) paid flag', () => {
    const req: HubstaffTimeOffRequest = {
      user_id: 2,
      status: 'approved',
      time_off_request_days: [{ date: '2026-06-05', amount_used: 28800 }],
    };
    const accum = accumulateActivities([]);
    accumulatePto(accum, [req], START_MS, STOP_MS);
    expect(accum.get(2)?.get('2026-06-05')?.pto).toBe(28800);
  });

  it('filters PTO days outside the sync window', () => {
    const req: HubstaffTimeOffRequest = {
      user_id: 3,
      status: 'approved',
      time_off_request_days: [
        { date: '2026-05-31', amount_used: 28800 }, // before window
        { date: '2026-06-01', amount_used: 28800 }, // inside
        { date: '2026-06-16', amount_used: 28800 }, // after window
      ],
    };
    const accum = accumulateActivities([]);
    accumulatePto(accum, [req], START_MS, STOP_MS);
    const userMap = accum.get(3);
    expect(userMap?.has('2026-05-31')).toBeFalsy();
    expect(userMap?.has('2026-06-16')).toBeFalsy();
    expect(userMap?.get('2026-06-01')?.pto).toBe(28800);
  });

  it('accumulates multiple days from a single request', () => {
    const req: HubstaffTimeOffRequest = {
      user_id: 4,
      status: 'approved',
      time_off_request_days: [
        { date: '2026-06-02', amount_used: 28800 },
        { date: '2026-06-03', amount_used: 28800 },
      ],
    };
    const accum = accumulateActivities([]);
    accumulatePto(accum, [req], START_MS, STOP_MS);
    expect(accum.get(4)?.size).toBe(2);
  });

  it('merges PTO into existing tracked accum for same user/day', () => {
    const acts: HubstaffDailyActivity[] = [makeActivity(5, '2026-06-05', 7200, 7200)];
    const accum = accumulateActivities(acts);
    const req: HubstaffTimeOffRequest = {
      user_id: 5,
      status: 'approved',
      time_off_request_days: [{ date: '2026-06-05', amount_used: 14400 }],
    };
    accumulatePto(accum, [req], START_MS, STOP_MS);
    const day = accum.get(5)?.get('2026-06-05');
    expect(day?.tracked).toBe(7200);
    expect(day?.pto).toBe(14400);
  });
});

// ─── buildWorkerMatchIndex + matchWorker ──────────────────────────────────────

describe('matchWorker', () => {
  it('prefers hubstaff_user_id over name match', () => {
    const links: WorkerLink[] = [
      makeLink(WORKER_ID_A, COMPANY_ID, {
        hubstaffUserId: 101,
        hubstaffName: 'Alice Smith',
      }),
      makeLink(WORKER_ID_B, COMPANY_ID, { hubstaffName: 'user 101' }),
    ];
    const idx = buildWorkerMatchIndex(links);
    // uid 101 matches WORKER_ID_A via byId
    expect(matchWorker(101, 'user 101', idx)).toBe(WORKER_ID_A);
  });

  it('strict name key matches accent-stripped, order-insensitive', () => {
    const links: WorkerLink[] = [
      makeLink(WORKER_ID_A, COMPANY_ID, {
        firstName: 'María',
        lastName: 'Santos',
      }),
    ];
    const idx = buildWorkerMatchIndex(links);
    // "Santos Maria" → sorted tokens ["maria","santos"] → same key
    expect(matchWorker(999, 'Santos Maria', idx)).toBe(WORKER_ID_A);
  });

  it('loose name key matches with extra middle token', () => {
    const links: WorkerLink[] = [
      makeLink(WORKER_ID_A, COMPANY_ID, {
        firstName: 'Juan',
        lastName: 'Cruz',
      }),
    ];
    const idx = buildWorkerMatchIndex(links);
    // "Juan Miguel Cruz" → loose key = "juan cruz"
    expect(matchWorker(999, 'Juan Miguel Cruz', idx)).toBe(WORKER_ID_A);
  });

  it('returns null for an unrecognised name', () => {
    const links: WorkerLink[] = [
      makeLink(WORKER_ID_A, COMPANY_ID, { hubstaffName: 'Alice Smith' }),
    ];
    const idx = buildWorkerMatchIndex(links);
    expect(matchWorker(999, 'Bob Jones', idx)).toBeNull();
  });

  it('resolves "Ma Dela Cruz Jr" via nameKey normalisation', () => {
    // "Ma" → "Maria", "Jr" stripped → tokens ["dela","cruz","maria"] → sorted key
    const links: WorkerLink[] = [
      makeLink(WORKER_ID_A, COMPANY_ID, {
        firstName: 'Maria Dela',
        lastName: 'Cruz',
      }),
    ];
    const idx = buildWorkerMatchIndex(links);
    expect(matchWorker(999, 'Ma Dela Cruz Jr', idx)).toBe(WORKER_ID_A);
  });
});

// ─── buildDecidedSets ─────────────────────────────────────────────────────────

describe('buildDecidedSets', () => {
  it('includes approved rows in both guard sets', () => {
    const entries: ExistingDecidedEntry[] = [
      {
        company_id: COMPANY_ID,
        worker_id: WORKER_ID_A,
        source_name: 'Alice Smith',
        work_date: '2026-06-01',
        approval: 'approved',
      },
    ];
    const { decidedBySrc, decidedByWorker } = buildDecidedSets(entries);
    expect(decidedBySrc.has(`${COMPANY_ID}|Alice Smith|2026-06-01`)).toBe(true);
    expect(decidedByWorker.has(`${COMPANY_ID}|${WORKER_ID_A}|2026-06-01`)).toBe(true);
  });

  it('includes rejected rows', () => {
    const entries: ExistingDecidedEntry[] = [
      {
        company_id: COMPANY_ID,
        worker_id: WORKER_ID_A,
        source_name: 'Alice Smith',
        work_date: '2026-06-02',
        approval: 'rejected',
      },
    ];
    const { decidedBySrc } = buildDecidedSets(entries);
    expect(decidedBySrc.has(`${COMPANY_ID}|Alice Smith|2026-06-02`)).toBe(true);
  });

  it('excludes pending rows', () => {
    const entries: ExistingDecidedEntry[] = [
      {
        company_id: COMPANY_ID,
        worker_id: WORKER_ID_A,
        source_name: 'Alice Smith',
        work_date: '2026-06-03',
        approval: 'pending',
      },
    ];
    const { decidedBySrc, decidedByWorker } = buildDecidedSets(entries);
    expect(decidedBySrc.has(`${COMPANY_ID}|Alice Smith|2026-06-03`)).toBe(false);
    expect(decidedByWorker.has(`${COMPANY_ID}|${WORKER_ID_A}|2026-06-03`)).toBe(false);
  });
});

// ─── transformActivities ──────────────────────────────────────────────────────

describe('transformActivities', () => {
  const DAYS = ['2026-06-01', '2026-06-02', '2026-06-03'];
  const BATCH_ID = 'test-batch-001';

  function runTransform(opts: {
    acts?: HubstaffDailyActivity[];
    links?: WorkerLink[];
    canonical?: Map<string, string>;
    decided?: ExistingDecidedEntry[];
  }) {
    const acts = opts.acts ?? [];
    const links = opts.links ?? [
      makeLink(WORKER_ID_A, COMPANY_ID, {
        hubstaffUserId: 1,
        hubstaffName: 'Alice Smith',
      }),
    ];
    const accum = accumulateActivities(acts);
    const idx = buildWorkerMatchIndex(links);
    const canonical = opts.canonical ?? new Map();
    const decidedEntries = opts.decided ?? [];
    const decided = buildDecidedSets(decidedEntries);
    const nameById = new Map<number, string>([
      [1, 'Alice Smith'],
      [2, 'Bob Jones'],
    ]);
    return transformActivities({
      accum,
      nameById,
      idx,
      canonical,
      decided,
      targetCompanyId: COMPANY_ID,
      days: DAYS,
      importBatchId: BATCH_ID,
    });
  }

  it('produces one row per matched user/day with time', () => {
    const acts: HubstaffDailyActivity[] = [makeActivity(1, '2026-06-01', 7200, 7200)];
    const result = runTransform({ acts });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.work_date).toBe('2026-06-01');
    expect(result.rows[0]?.tracked_seconds).toBe(7200);
  });

  it('adds unmatched Hubstaff names to unmatched list', () => {
    // User 2 ("Bob Jones") has no matching WorkerLink.
    const acts: HubstaffDailyActivity[] = [makeActivity(2, '2026-06-01', 7200, 7200)];
    const result = runTransform({ acts });
    expect(result.unmatched).toContain('Bob Jones');
    expect(result.rows).toHaveLength(0);
  });

  it('skips rows with approval=approved (decided guard)', () => {
    const acts: HubstaffDailyActivity[] = [makeActivity(1, '2026-06-01', 7200, 7200)];
    const decided: ExistingDecidedEntry[] = [
      {
        company_id: COMPANY_ID,
        worker_id: WORKER_ID_A,
        source_name: 'Alice Smith',
        work_date: '2026-06-01',
        approval: 'approved',
      },
    ];
    const result = runTransform({ acts, decided });
    expect(result.rows).toHaveLength(0);
  });

  it('skips rows with approval=rejected (decided guard)', () => {
    const acts: HubstaffDailyActivity[] = [makeActivity(1, '2026-06-01', 7200, 7200)];
    const decided: ExistingDecidedEntry[] = [
      {
        company_id: COMPANY_ID,
        worker_id: WORKER_ID_A,
        source_name: 'Alice Smith',
        work_date: '2026-06-01',
        approval: 'rejected',
      },
    ];
    const result = runTransform({ acts, decided });
    expect(result.rows).toHaveLength(0);
  });

  it('keeps rows with approval=pending (not decided)', () => {
    const acts: HubstaffDailyActivity[] = [makeActivity(1, '2026-06-01', 7200, 7200)];
    const decided: ExistingDecidedEntry[] = [
      {
        company_id: COMPANY_ID,
        worker_id: WORKER_ID_A,
        source_name: 'Alice Smith',
        work_date: '2026-06-01',
        approval: 'pending',
      },
    ];
    const result = runTransform({ acts, decided });
    expect(result.rows).toHaveLength(1);
  });

  it('F3: records a divergence when a decided day’s Hubstaff seconds changed (still no row)', () => {
    const acts: HubstaffDailyActivity[] = [makeActivity(1, '2026-06-01', 10800, 10800)];
    const decided: ExistingDecidedEntry[] = [
      {
        company_id: COMPANY_ID,
        worker_id: WORKER_ID_A,
        source_name: 'Alice Smith',
        work_date: '2026-06-01',
        approval: 'approved',
        tracked_seconds: 7200, // approved at 2h; Hubstaff now reports 3h
        pto_seconds: 0,
      },
    ];
    const result = runTransform({ acts, decided });
    expect(result.rows).toHaveLength(0); // never overwrite a decided row
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]).toMatchObject({
      workDate: '2026-06-01',
      storedTracked: 7200,
      incomingTracked: 10800,
    });
  });

  it('F3: no divergence when a decided day’s seconds are unchanged', () => {
    const acts: HubstaffDailyActivity[] = [makeActivity(1, '2026-06-01', 7200, 7200)];
    const decided: ExistingDecidedEntry[] = [
      {
        company_id: COMPANY_ID,
        worker_id: WORKER_ID_A,
        source_name: 'Alice Smith',
        work_date: '2026-06-01',
        approval: 'approved',
        tracked_seconds: 7200,
        pto_seconds: 0,
      },
    ];
    const result = runTransform({ acts, decided });
    expect(result.rows).toHaveLength(0);
    expect(result.divergences).toHaveLength(0);
  });

  it('F3: pending days are not divergence-checked (they upsert normally)', () => {
    const acts: HubstaffDailyActivity[] = [makeActivity(1, '2026-06-01', 10800, 10800)];
    const decided: ExistingDecidedEntry[] = [
      {
        company_id: COMPANY_ID,
        worker_id: WORKER_ID_A,
        source_name: 'Alice Smith',
        work_date: '2026-06-01',
        approval: 'pending',
        tracked_seconds: 7200,
        pto_seconds: 0,
      },
    ];
    const result = runTransform({ acts, decided });
    expect(result.rows).toHaveLength(1); // pending refreshes
    expect(result.divergences).toHaveLength(0);
  });

  it('resolves canonical source_name from prior time_entries', () => {
    const canonical = new Map([[`${COMPANY_ID}|${WORKER_ID_A}`, 'alice smith']]);
    const acts: HubstaffDailyActivity[] = [makeActivity(1, '2026-06-01', 7200, 7200)];
    const result = runTransform({ acts, canonical });
    expect(result.rows[0]?.source_name).toBe('alice smith');
  });

  it('computes activity_pct correctly', () => {
    // overall=6000, tracked=8000 → 6000/8000*100 = 75
    const acts: HubstaffDailyActivity[] = [makeActivity(1, '2026-06-01', 8000, 6000)];
    const result = runTransform({ acts });
    expect(result.rows[0]?.activity_pct).toBe(75);
  });

  it('sets activity_pct null on PTO-only days', () => {
    // tracked=0, pto>0
    const accum = accumulateActivities([]);
    accumulatePto(
      accum,
      [
        {
          user_id: 1,
          status: 'approved',
          time_off_request_days: [{ date: '2026-06-01', amount_used: 28800 }],
        },
      ],
      new Date('2026-06-01T00:00:00Z').getTime(),
      new Date('2026-06-03T23:59:59Z').getTime(),
    );
    const links: WorkerLink[] = [
      makeLink(WORKER_ID_A, COMPANY_ID, {
        hubstaffUserId: 1,
        hubstaffName: 'Alice Smith',
      }),
    ];
    const idx = buildWorkerMatchIndex(links);
    const result = transformActivities({
      accum,
      nameById: new Map([[1, 'Alice Smith']]),
      idx,
      canonical: new Map(),
      decided: buildDecidedSets([]),
      targetCompanyId: COMPANY_ID,
      days: DAYS,
      importBatchId: BATCH_ID,
    });
    expect(result.rows[0]?.activity_pct).toBeNull();
    expect(result.rows[0]?.pto_seconds).toBe(28800);
    expect(result.rows[0]?.tracked_seconds).toBe(0);
  });

  it('records idsToPersist for name-matched links (hubstaff_user_id was null)', () => {
    const links: WorkerLink[] = [
      makeLink(WORKER_ID_A, COMPANY_ID, {
        hubstaffUserId: null, // not set yet
        hubstaffName: 'Alice Smith',
      }),
    ];
    const acts: HubstaffDailyActivity[] = [makeActivity(1, '2026-06-01', 7200, 7200)];
    const accum = accumulateActivities(acts);
    const idx = buildWorkerMatchIndex(links);
    const result = transformActivities({
      accum,
      nameById: new Map([[1, 'Alice Smith']]),
      idx,
      canonical: new Map(),
      decided: buildDecidedSets([]),
      targetCompanyId: COMPANY_ID,
      days: DAYS,
      importBatchId: BATCH_ID,
    });
    expect(result.idsToPersist).toHaveLength(1);
    expect(result.idsToPersist[0]?.hubstaffUserId).toBe(1);
    expect(result.idsToPersist[0]?.workerId).toBe(WORKER_ID_A);
  });

  it('does NOT add to idsToPersist when hubstaff_user_id already stored', () => {
    const acts: HubstaffDailyActivity[] = [makeActivity(1, '2026-06-01', 7200, 7200)];
    const result = runTransform({ acts }); // default link has hubstaffUserId: 1
    expect(result.idsToPersist).toHaveLength(0);
  });

  it('sets approval to pending on all rows', () => {
    const acts: HubstaffDailyActivity[] = [makeActivity(1, '2026-06-01', 7200, 7200)];
    const result = runTransform({ acts });
    for (const row of result.rows) {
      expect(row.approval).toBe('pending');
    }
  });
});

// ─── dateRange ────────────────────────────────────────────────────────────────

describe('dateRange', () => {
  it('returns inclusive ordered dates', () => {
    const days = dateRange('2026-06-01', '2026-06-03');
    expect(days).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });

  it('returns a single-element array for same start and stop', () => {
    const days = dateRange('2026-06-15', '2026-06-15');
    expect(days).toEqual(['2026-06-15']);
  });

  it('returns empty array when stop is before start', () => {
    const days = dateRange('2026-06-05', '2026-06-01');
    expect(days).toEqual([]);
  });
});

// ─── resolveWindow ────────────────────────────────────────────────────────────

describe('resolveWindow', () => {
  it('uses explicit start/stop when provided', () => {
    const w = resolveWindow({ start: '2026-06-01', stop: '2026-06-15' });
    expect(w.start).toBe('2026-06-01');
    expect(w.stop).toBe('2026-06-15');
  });

  it('computes lookback window from today', () => {
    const w = resolveWindow({ lookbackDays: 3, today: '2026-06-10' });
    expect(w.stop).toBe('2026-06-10');
    expect(w.start).toBe('2026-06-07');
  });

  it('clamps lookbackDays to 0-31', () => {
    const w1 = resolveWindow({ lookbackDays: -5, today: '2026-06-10' });
    expect(w1.start).toBe('2026-06-10'); // 0 days lookback

    const w2 = resolveWindow({ lookbackDays: 999, today: '2026-06-10' });
    // 31 days back from 2026-06-10 = 2026-05-10
    expect(w2.start).toBe('2026-05-10');
  });

  it('defaults lookbackDays to 3 when omitted', () => {
    const w = resolveWindow({ today: '2026-06-10' });
    expect(w.start).toBe('2026-06-07');
  });
});
