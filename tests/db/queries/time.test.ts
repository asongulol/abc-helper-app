import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  type CsvRow,
  canonicalizeCsvRows,
  csvRowsToWrite,
  datesOutsidePeriod,
  type ExistingDay,
  fetchApprovalSnapshot,
  isEntryUnpaid,
  mergeAddedHours,
  type PeriodLockInfo,
  restoreApprovals,
  unapproveWindow,
  updateApproval,
  updateTrackedSeconds,
  upsertTimeEntries,
} from '@/db/queries/time';
import type { Database } from '@/db/types';

const day = (over: Partial<ExistingDay> = {}): ExistingDay => ({
  sourceName: 'Ana Cruz',
  workDate: '2026-07-04',
  approval: 'pending',
  trackedSeconds: 0,
  ptoSeconds: 0,
  clientCompanyId: null,
  importBatchId: null,
  ...over,
});

describe('csvRowsToWrite — CSV import must not blank days it has nothing to say about (RP-13)', () => {
  const rows = [
    { sourceName: 'Ana Cruz', workDate: '2026-07-03', trackedSeconds: 28_800 },
    { sourceName: 'Ana Cruz', workDate: '2026-07-04', trackedSeconds: 0 },
    { sourceName: 'Ana Cruz', workDate: '2026-07-05', trackedSeconds: 14_400 },
  ];

  it('drops zero-second days in overwrite mode — the repro: Jul 4 is 0h tracked + 8h PTO, approved', () => {
    const existing = [day({ workDate: '2026-07-04', approval: 'approved', ptoSeconds: 28_800 })];
    const out = csvRowsToWrite(rows, existing, 'upsert');
    expect(out.map((r) => r.workDate)).toEqual(['2026-07-03', '2026-07-05']);
  });

  it('never overwrites a decided day in overwrite mode, even when the CSV has hours for it', () => {
    const existing = [day({ workDate: '2026-07-05', approval: 'approved', trackedSeconds: 3_600 })];
    expect(csvRowsToWrite(rows, existing, 'upsert').map((r) => r.workDate)).toEqual(['2026-07-03']);
  });

  it('rejected counts as decided too', () => {
    const existing = [day({ workDate: '2026-07-03', approval: 'rejected' })];
    expect(csvRowsToWrite(rows, existing, 'upsert').map((r) => r.workDate)).toEqual(['2026-07-05']);
  });

  it('still overwrites a day that is only pending — re-importing a corrected CSV must work', () => {
    const existing = [day({ workDate: '2026-07-03', approval: 'pending', trackedSeconds: 3_600 })];
    expect(csvRowsToWrite(rows, existing, 'upsert').map((r) => r.workDate)).toEqual([
      '2026-07-03',
      '2026-07-05',
    ]);
  });

  it('skip mode drops every key that already exists, decided or not', () => {
    const existing = [day({ workDate: '2026-07-03', approval: 'pending' })];
    expect(csvRowsToWrite(rows, existing, 'skip').map((r) => r.workDate)).toEqual(['2026-07-05']);
  });

  it('keys on (source_name, work_date) — another contractor on the same day is unaffected', () => {
    const existing = [
      day({ sourceName: 'Ben Diaz', workDate: '2026-07-03', approval: 'approved' }),
    ];
    expect(csvRowsToWrite(rows, existing, 'upsert').map((r) => r.workDate)).toEqual([
      '2026-07-03',
      '2026-07-05',
    ]);
  });
});

describe('mergeAddedHours — "Add hours" adds, it does not replace (RP-14)', () => {
  const addition = {
    sourceName: 'Ana Cruz',
    workDate: '2026-07-01',
    seconds: 36_000, // 10h
    clientCompanyId: null,
    importBatchId: 'batch-new',
  };

  it('sums onto the hours already on the day — the repro: 5h synced + 10h added = 15h, not 10h', () => {
    const { merged, decided } = mergeAddedHours(
      [addition],
      [day({ workDate: '2026-07-01', trackedSeconds: 18_000 })],
    );
    expect(decided).toEqual([]);
    expect(merged[0]?.trackedSeconds).toBe(54_000);
  });

  it('preserves PTO and client attribution the add says nothing about', () => {
    const { merged } = mergeAddedHours(
      [addition],
      [day({ workDate: '2026-07-01', ptoSeconds: 28_800, clientCompanyId: 'client-a' })],
    );
    expect(merged[0]?.ptoSeconds).toBe(28_800);
    expect(merged[0]?.clientCompanyId).toBe('client-a');
  });

  it('an explicit client on the add wins over the stored one', () => {
    const { merged } = mergeAddedHours(
      [{ ...addition, clientCompanyId: 'client-b' }],
      [day({ workDate: '2026-07-01', clientCompanyId: 'client-a' })],
    );
    expect(merged[0]?.clientCompanyId).toBe('client-b');
  });

  it('refuses a day that is already approved instead of re-opening it', () => {
    const { merged, decided } = mergeAddedHours(
      [addition],
      [day({ workDate: '2026-07-01', approval: 'approved', trackedSeconds: 18_000 })],
    );
    expect(decided).toEqual(['2026-07-01']);
    expect(merged).toEqual([]);
  });

  it('writes a fresh row when the day does not exist yet', () => {
    const { merged } = mergeAddedHours([addition], []);
    expect(merged[0]).toMatchObject({
      workDate: '2026-07-01',
      trackedSeconds: 36_000,
      ptoSeconds: 0,
      importBatchId: 'batch-new',
    });
  });

  it('a merged day keeps its original batch id so deleting the new batch cannot strip pre-existing hours', () => {
    const { merged } = mergeAddedHours(
      [addition],
      [day({ workDate: '2026-07-01', importBatchId: 'batch-old' })],
    );
    expect(merged[0]?.importBatchId).toBe('batch-old');
  });

  it('reports every decided date once, sorted, and still merges the rest', () => {
    const { merged, decided } = mergeAddedHours(
      [
        { ...addition, workDate: '2026-07-02' },
        { ...addition, workDate: '2026-07-01' },
        { ...addition, workDate: '2026-07-03' },
      ],
      [
        day({ workDate: '2026-07-02', approval: 'approved' }),
        day({ workDate: '2026-07-01', approval: 'rejected' }),
      ],
    );
    expect(decided).toEqual(['2026-07-01', '2026-07-02']);
    expect(merged.map((m) => m.workDate)).toEqual(['2026-07-03']);
  });
});

describe('datesOutsidePeriod — edit-total may not move hours between periods (RP-15)', () => {
  it('flags the repro: a row aggregating Jun 20 and Jul 8 edited as the Jul 1–15 total', () => {
    expect(
      datesOutsidePeriod(
        [{ workDate: '2026-06-20' }, { workDate: '2026-07-08' }],
        '2026-07-01',
        '2026-07-15',
      ),
    ).toEqual(['2026-06-20']);
  });

  it('passes a row entirely inside the period, boundaries included', () => {
    expect(
      datesOutsidePeriod(
        [{ workDate: '2026-07-01' }, { workDate: '2026-07-15' }],
        '2026-07-01',
        '2026-07-15',
      ),
    ).toEqual([]);
  });

  it('de-duplicates and sorts the offending dates', () => {
    expect(
      datesOutsidePeriod(
        [{ workDate: '2026-07-20' }, { workDate: '2026-06-20' }, { workDate: '2026-07-20' }],
        '2026-07-01',
        '2026-07-15',
      ),
    ).toEqual(['2026-06-20', '2026-07-20']);
  });
});

describe('isEntryUnpaid — time approved after a lock is still owed (RP-16)', () => {
  const julyLocked: PeriodLockInfo = {
    id: 'p1',
    periodStart: '2026-07-01',
    periodEnd: '2026-07-15',
    state: 'locked',
    lockedAt: '2026-07-16T08:00:00+00:00',
  };

  it('the repro: a Jul 15 row approved the night AFTER the Jul 16 lock stays unpaid', () => {
    expect(
      isEntryUnpaid(
        { approval: 'approved', workDate: '2026-07-15', approvedAt: '2026-07-17T02:00:00+00:00' },
        [julyLocked],
      ),
    ).toBe(true);
  });

  it('time approved before the lock was on the run — paid', () => {
    expect(
      isEntryUnpaid(
        { approval: 'approved', workDate: '2026-07-15', approvedAt: '2026-07-16T07:00:00+00:00' },
        [julyLocked],
      ),
    ).toBe(false);
  });

  it('pending is unpaid regardless of the period state', () => {
    expect(
      isEntryUnpaid({ approval: 'pending', workDate: '2026-07-15', approvedAt: null }, [
        julyLocked,
      ]),
    ).toBe(true);
  });

  it('approved time in a still-open period is unpaid (no closed period contains it)', () => {
    expect(
      isEntryUnpaid(
        { approval: 'approved', workDate: '2026-07-20', approvedAt: '2026-07-21T00:00:00+00:00' },
        [julyLocked],
      ),
    ).toBe(true);
  });

  it('unknown timing counts as PAID — a pre-F8 row with no approved_at is not resurrected', () => {
    expect(
      isEntryUnpaid({ approval: 'approved', workDate: '2026-07-15', approvedAt: null }, [
        julyLocked,
      ]),
    ).toBe(false);
  });

  it('unknown timing counts as PAID — a period locked without a locked_at stamp', () => {
    expect(
      isEntryUnpaid(
        { approval: 'approved', workDate: '2026-07-15', approvedAt: '2026-07-17T02:00:00+00:00' },
        [{ ...julyLocked, lockedAt: null }],
      ),
    ).toBe(false);
  });

  it('picks the period that contains the date, not just any closed period', () => {
    const juneLocked: PeriodLockInfo = {
      id: 'p0',
      periodStart: '2026-06-16',
      periodEnd: '2026-06-30',
      state: 'paid',
      lockedAt: '2026-07-01T08:00:00+00:00',
    };
    // Approved Jul 17 — after June's lock but before nothing that matters; the
    // containing period is July's, so the July cutoff is the one applied.
    expect(
      isEntryUnpaid(
        { approval: 'approved', workDate: '2026-06-20', approvedAt: '2026-06-25T00:00:00+00:00' },
        [juneLocked, julyLocked],
      ),
    ).toBe(false);
  });
});

describe('canonicalizeCsvRows — a Hubstaff rename must not double-pay (RP-38/RP-46)', () => {
  const row = (over: Partial<CsvRow> = {}): CsvRow => ({
    sourceName: 'Maria Cristina Cruz',
    workerId: 'w1',
    workDate: '2026-07-04',
    trackedSeconds: 28_800,
    activityPct: 70,
    ...over,
  });

  it('rewrites source_name to the one the worker already has rows under', () => {
    // The repro: rows exist as "Ma. Cristina Cruz" (approved); the name is
    // edited in Hubstaff; the re-imported CSV carries the NEW spelling. Without
    // the rewrite it inserts a second set of rows for the same days and
    // attributeTimeEntries sums both.
    const out = canonicalizeCsvRows(
      [row()],
      new Map([['Maria Cristina Cruz', { workerId: 'w1', sourceName: 'Ma. Cristina Cruz' }]]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.sourceName).toBe('Ma. Cristina Cruz');
    expect(out[0]?.workerId).toBe('w1');
  });

  it('ignores the workerId the client sent and uses the server-resolved one', () => {
    const out = canonicalizeCsvRows(
      [row({ workerId: 'attacker-picked-worker' })],
      new Map([['Maria Cristina Cruz', { workerId: 'w1', sourceName: 'Maria Cristina Cruz' }]]),
    );
    expect(out[0]?.workerId).toBe('w1');
  });

  it('drops a client workerId the server could not match at all', () => {
    const out = canonicalizeCsvRows([row({ sourceName: 'Ghost Name' })], new Map());
    expect(out[0]?.workerId).toBeNull();
    // Name kept as-is — the row still lands, unattributed, and shows as unmatched.
    expect(out[0]?.sourceName).toBe('Ghost Name');
  });

  it('sums two spellings of one worker on the same day instead of colliding', () => {
    // Both names canonicalise to one key; a duplicate conflict key in a single
    // upsert is a hard Postgres error, and dropping one would lose the hours.
    const resolved = new Map([
      ['Ma. Cristina Cruz', { workerId: 'w1', sourceName: 'Ma. Cristina Cruz' }],
      ['Maria Cristina Cruz', { workerId: 'w1', sourceName: 'Ma. Cristina Cruz' }],
    ]);
    const out = canonicalizeCsvRows(
      [
        row({ sourceName: 'Ma. Cristina Cruz', trackedSeconds: 3_600 }),
        row({ sourceName: 'Maria Cristina Cruz', trackedSeconds: 1_800 }),
      ],
      resolved,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.trackedSeconds).toBe(5_400);
  });

  it('keeps different days and different workers apart', () => {
    const out = canonicalizeCsvRows(
      [
        row({ workDate: '2026-07-04' }),
        row({ workDate: '2026-07-05' }),
        row({ sourceName: 'Ben Diaz', workerId: 'w2' }),
      ],
      new Map([
        ['Maria Cristina Cruz', { workerId: 'w1', sourceName: 'Ma. Cristina Cruz' }],
        ['Ben Diaz', { workerId: 'w2', sourceName: 'Ben Diaz' }],
      ]),
    );
    expect(out).toHaveLength(3);
  });
});

describe('upsertTimeEntries — nobody logs time after their last day', () => {
  type Link = { company_id: string; worker_id: string; ended_on: string | null };
  type Row = Parameters<typeof upsertTimeEntries>[1][number];

  const row = (over: Partial<Row> = {}): Row => ({
    company_id: 'co-1',
    worker_id: 'w1',
    source_name: 'Ana Cruz',
    work_date: '2026-07-04',
    tracked_seconds: 28_800,
    pto_seconds: 0,
    approval: 'pending',
    import_batch_id: 'b1',
    activity_pct: 70,
    ...over,
  });

  /** worker_companies reads resolve to `links`; the upsert payload is captured.
   *  The read chains .not() then .in() twice before it is awaited, and every
   *  filter is recorded — the stub answers with the fixture whatever it is asked,
   *  so a dropped or inverted filter is invisible to the behaviour tests (#94). */
  const stubDb = (links: Link[]) => {
    const written: Row[] = [];
    const filters: Record<string, unknown> = {};
    const read = Promise.resolve({ data: links, error: null }) as Promise<{
      data: Link[];
      error: null;
    }> &
      Record<string, unknown>;
    const record = (col: string, val: unknown) => {
      filters[col] = val;
      return read;
    };
    read.in = (col: string, vals: unknown) => record(`${col} in`, vals);
    // The operator is part of the key: `.is('ended_on', null)` is the INVERSE of
    // `.not('ended_on','is',null)` and must not land in the same slot.
    read.not = (col: string, op: string, val: unknown) => record(`${col} not ${op}`, val);
    read.is = (col: string, val: unknown) => record(`${col} is`, val);
    const db = {
      from: () => ({
        select: () => read,
        upsert: (rows: Row[]) => {
          written.push(...rows);
          return Promise.resolve({ error: null });
        },
      }),
    };
    return { db: db as unknown as SupabaseClient<Database>, written, filters };
  };

  it('drops the days after the last day and keeps the last day itself', async () => {
    const { db, written } = stubDb([
      { company_id: 'co-1', worker_id: 'w1', ended_on: '2026-07-04' },
    ]);
    const dropped = await upsertTimeEntries(db, [
      row({ work_date: '2026-07-03' }),
      row({ work_date: '2026-07-04' }),
      row({ work_date: '2026-07-05' }),
    ]);
    expect(written.map((r) => r.work_date)).toEqual(['2026-07-03', '2026-07-04']);
    expect(dropped).toBe(1);
  });

  it('ignores an ended link at ANOTHER company — a client assignment ending is not leaving', async () => {
    // The repro shape in prod: everyone is linked to the employer company that
    // holds all time, PLUS the clients they are assigned to.
    const { db, written } = stubDb([
      { company_id: 'co-1', worker_id: 'w1', ended_on: null },
      { company_id: 'client-a', worker_id: 'w1', ended_on: '2026-07-04' },
    ]);
    const dropped = await upsertTimeEntries(db, [row({ work_date: '2026-07-20' })]);
    expect(written).toHaveLength(1);
    expect(dropped).toBe(0);
  });

  it('drops on the employer link even while a client link stays open (termination stamps both, drift stamps one)', async () => {
    const { db, written } = stubDb([
      { company_id: 'co-1', worker_id: 'w1', ended_on: '2026-07-04' },
      { company_id: 'client-a', worker_id: 'w1', ended_on: null },
    ]);
    const dropped = await upsertTimeEntries(db, [row({ work_date: '2026-07-20' })]);
    expect(written).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('bounds each worker by their own last day', async () => {
    const { db, written } = stubDb([
      { company_id: 'co-1', worker_id: 'w1', ended_on: '2026-07-04' },
      { company_id: 'co-1', worker_id: 'w2', ended_on: null },
    ]);
    const dropped = await upsertTimeEntries(db, [
      row({ worker_id: 'w1', work_date: '2026-07-05' }),
      row({ worker_id: 'w2', source_name: 'Ben Diaz', work_date: '2026-07-05' }),
    ]);
    expect(written.map((r) => r.worker_id)).toEqual(['w2']);
    expect(dropped).toBe(1);
  });

  it('writes an unattributed row as-is — no worker, no last day to measure', async () => {
    const { db, written } = stubDb([
      { company_id: 'co-1', worker_id: 'w1', ended_on: '2026-07-04' },
    ]);
    const dropped = await upsertTimeEntries(db, [
      row({ worker_id: null, work_date: '2026-07-20' }),
    ]);
    expect(written).toHaveLength(1);
    expect(dropped).toBe(0);
  });

  it("leaves an 'ended' worker alone when the link was never stamped (the #79 drift)", async () => {
    const { db, written } = stubDb([{ company_id: 'co-1', worker_id: 'w1', ended_on: null }]);
    const dropped = await upsertTimeEntries(db, [row({ work_date: '2026-07-20' })]);
    expect(written).toHaveLength(1);
    expect(dropped).toBe(0);
  });

  // #94. Every test above feeds the guard its links directly, so they prove the
  // arithmetic and nothing about the read that supplies it. Written as
  // `.is('ended_on', null)` the read returns only OPEN links, the client-side
  // `if (link.ended_on)` then discards all of them, the map comes back empty and
  // every date after every last day imports — with all of the above still green.
  // Exact match, not a subset: an inverted filter shows up as an extra key.
  it('asks for ended links only, scoped to the workers and companies being written', async () => {
    const { db, filters } = stubDb([
      { company_id: 'co-1', worker_id: 'w1', ended_on: '2026-07-04' },
    ]);
    await upsertTimeEntries(db, [
      row({ work_date: '2026-07-03' }),
      row({ company_id: 'client-a', worker_id: 'w2', work_date: '2026-07-03' }),
      // Unattributed rows carry no worker to bound, so they widen neither list.
      row({ company_id: 'co-9', worker_id: null, work_date: '2026-07-03' }),
    ]);

    expect(filters).toEqual({
      'ended_on not is': null,
      'company_id in': ['co-1', 'client-a', 'co-9'],
      'worker_id in': ['w1', 'w2'],
    });
  });
});

describe('approval/undo/edit writes are company-scoped (RP-45)', () => {
  /** Records the filters each query applies, so a dropped .eq() fails the test.
   *  A real Promise underneath, like the awaitable Supabase builder. */
  type Chain = Promise<{ data: unknown[]; error: null }> & {
    eq: (col: string, val: unknown) => Chain;
    in: (col: string, val: unknown) => Chain;
    gte: (col: string, val: unknown) => Chain;
    lte: (col: string, val: unknown) => Chain;
    select: (cols: string) => Chain;
  };
  const stubDb = () => {
    const calls: Array<{ op: string; filters: Record<string, unknown>; payload?: unknown }> = [];
    const builder = (op: string, payload?: unknown): Chain => {
      const rec = { op, filters: {} as Record<string, unknown>, payload };
      calls.push(rec);
      const chain = Promise.resolve({ data: [] as unknown[], error: null }) as Chain;
      const record = (col: string, val: unknown) => {
        rec.filters[col] = val;
        return chain;
      };
      chain.eq = record;
      chain.in = record;
      // Range bounds get their own keys — both are work_date, so one map slot
      // would hide a dropped end of the window.
      chain.gte = (col, val) => record(`${col}>=`, val);
      chain.lte = (col, val) => record(`${col}<=`, val);
      chain.select = () => chain;
      return chain;
    };
    const db = {
      from: () => ({
        select: () => builder('select'),
        update: (patch: unknown) => builder('update', patch),
      }),
    };
    return { db: db as unknown as SupabaseClient<Database>, calls };
  };

  it('scopes the approval update by company, not just id', async () => {
    const { db, calls } = stubDb();
    await updateApproval(db, 'co-1', ['e1', 'e2'], 'approved', 'admin-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.filters.company_id).toBe('co-1');
    expect(calls[0]?.filters.id).toEqual(['e1', 'e2']);
  });

  it('un-approves one worker inside the window only — rejected days stay rejected', async () => {
    const { db, calls } = stubDb();
    await unapproveWindow(db, 'co-1', '2026-07-01', '2026-07-15', 'w-9');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({
      approval: 'pending',
      approved_at: null,
      approved_by: null,
    });
    expect(calls[0]?.filters).toEqual({
      company_id: 'co-1',
      // Only rows that are currently approved — a rejected day was decided
      // against, and re-opening it would resurrect discarded work.
      approval: 'approved',
      'work_date>=': '2026-07-01',
      'work_date<=': '2026-07-15',
      worker_id: 'w-9',
    });
  });

  it('un-approves the whole window when no worker is given (Clear batch)', async () => {
    const { db, calls } = stubDb();
    await unapproveWindow(db, 'co-1', '2026-07-01', '2026-07-15');
    expect(calls[0]?.filters).not.toHaveProperty('worker_id');
    expect(calls[0]?.filters.company_id).toBe('co-1');
  });

  it('scopes the undo restore by company', async () => {
    const { db, calls } = stubDb();
    await restoreApprovals(db, 'co-1', [{ id: 'e1', approval: 'pending' }]);
    expect(calls.every((c) => c.filters.company_id === 'co-1')).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('scopes the edit-total write by company', async () => {
    const { db, calls } = stubDb();
    await updateTrackedSeconds(db, 'co-1', [{ id: 'e1', trackedSeconds: 3_600 }]);
    expect(calls[0]?.filters.company_id).toBe('co-1');
    expect(calls[0]?.filters.id).toBe('e1');
  });

  it('scopes the undo snapshot read, so a foreign id comes back short', async () => {
    const { db, calls } = stubDb();
    // Stub returns no rows: the caller compares length against ids and refuses.
    const snapshot = await fetchApprovalSnapshot(db, 'co-1', ['e1']);
    expect(snapshot).toHaveLength(0);
    expect(calls[0]?.filters.company_id).toBe('co-1');
  });
});
