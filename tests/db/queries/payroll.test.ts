import { describe, expect, it } from 'vitest';
import { selectAll } from '@/db/queries/paging';
import {
  applyGrossOverride,
  composeNetCentavos,
  lockBlockedReason,
  lockWarningReason,
  MARKABLE_PAID_STATUSES,
  mergeManualColumns,
  type OpenDraft,
  officeToday,
  PAYABLE_PERIOD_STATES,
  preferredOpenDraft,
  resolveOpenDraftForDate,
  sessionIdsToRelease,
  sessionPaidWorkers,
  unlockBlockedReason,
  unpayablePeriodReason,
} from '@/db/queries/payroll';
import { periodFor } from '@/lib/dates/periods';
import { centavos } from '@/lib/money';

describe('resolveOpenDraftForDate — date-containment draft resolution (audit #001/#009)', () => {
  const juneDraft: OpenDraft = { id: 'june', periodStart: '2026-06-01', periodEnd: '2026-06-15' };
  const julyDraft: OpenDraft = { id: 'july', periodStart: '2026-07-01', periodEnd: '2026-07-15' };

  it('resolves the draft whose window contains the date', () => {
    expect(resolveOpenDraftForDate([juneDraft, julyDraft], '2026-07-08')).toEqual(julyDraft);
  });

  it('resolves the other draft when the date falls in its window instead', () => {
    expect(resolveOpenDraftForDate([juneDraft, julyDraft], '2026-06-10')).toEqual(juneDraft);
  });

  it('matches on the inclusive boundary dates', () => {
    expect(resolveOpenDraftForDate([julyDraft], '2026-07-01')).toEqual(julyDraft);
    expect(resolveOpenDraftForDate([julyDraft], '2026-07-15')).toEqual(julyDraft);
  });

  it('returns null when no open period covers the date — the repro case (no Jul 1-15 draft yet)', () => {
    // Only June is open; a Jul 8 session must NOT fall back to June's draft.
    expect(resolveOpenDraftForDate([juneDraft], '2026-07-08')).toBeNull();
  });

  it('returns null for a date inside a LOCKED period — locked periods are never in the candidate list', () => {
    // findCurrentOpenDraft only ever passes state='open' rows; a locked June
    // period simply isn't a candidate, so a Jun 20 session resolves to null
    // instead of spilling into an unrelated open Jul draft.
    expect(resolveOpenDraftForDate([julyDraft], '2026-06-20')).toBeNull();
  });

  it('returns null with no open periods at all', () => {
    expect(resolveOpenDraftForDate([], '2026-07-08')).toBeNull();
  });
});

describe('sessionIdsToRelease — free the sessions behind deleted statements', () => {
  it('releases every session-backed ledger row and skips manual/catch-up rows (null session_id)', () => {
    expect(
      sessionIdsToRelease([
        { session_id: 's1' },
        { session_id: null }, // manual per-hour date entry
        { session_id: 's2' },
        { session_id: null }, // salaried catch-up
      ]),
    ).toEqual(['s1', 's2']);
  });

  it('releases nothing when the deleted statements carried no ledger-paid sessions', () => {
    expect(sessionIdsToRelease([])).toEqual([]);
  });
});

describe('sessionPaidWorkers — whose sessions a lock stamps paid (RP-01)', () => {
  const row = (workerId: string, units: number | null) => ({
    workerId,
    paymentId: `pay-${workerId}`,
    units,
  });

  it('picks per_session rows (units set) and skips salaried / per_hour rows (units null)', () => {
    expect(sessionPaidWorkers([row('ps', 8), row('salaried', null), row('hourly', null)])).toEqual([
      { workerId: 'ps', paymentId: 'pay-ps' },
    ]);
  });

  it('keeps a per_session row that summed to zero units — units 0 is still a session row', () => {
    // All of their in-window sessions were already paid off-cycle; the UPDATE
    // then matches nothing, but excluding them here would be wrong the moment a
    // session lands in-window between the recalc and the lock.
    expect(sessionPaidWorkers([row('ps', 0)])).toEqual([{ workerId: 'ps', paymentId: 'pay-ps' }]);
  });

  it('stamps nothing for a period with no session-paid workers', () => {
    expect(sessionPaidWorkers([row('salaried', null)])).toEqual([]);
  });
});

describe('unlockBlockedReason — what must be cleared before reopening a lock (RP-10/RP-12)', () => {
  const paid = (name: string, wiseTransferId: string | null) => ({ name, wiseTransferId });

  it('allows the unlock when nothing is outstanding', () => {
    expect(unlockBlockedReason([paid('Ana', null), paid('Ben', null)], [])).toBeNull();
    expect(unlockBlockedReason([], [])).toBeNull();
  });

  it('blocks on a live Wise draft and names who it belongs to (RP-10)', () => {
    const reason = unlockBlockedReason([paid('Ana', null), paid('Ben', 'tr-48000')], []);
    expect(reason).toContain('Ben');
    expect(reason).not.toContain('Ana'); // only the drafted row is the blocker
    expect(reason).toMatch(/cancel the transfer/i);
  });

  it('blocks on a salaried catch-up that already paid this period’s hours (RP-12)', () => {
    const reason = unlockBlockedReason([paid('Ana', null)], [{ workerName: 'Ana', units: 8 }]);
    expect(reason).toContain('Ana (8h)');
    expect(reason).toMatch(/twice/i);
  });

  it('reports both blockers together rather than hiding the second one', () => {
    const reason = unlockBlockedReason([paid('Ben', 'tr-1')], [{ workerName: 'Ana', units: null }]);
    expect(reason).toContain('Ben');
    expect(reason).toContain('Ana');
  });

  it('still names an unnamed worker instead of producing an empty list', () => {
    expect(unlockBlockedReason([paid('', 'tr-1')], [])).toContain('Unnamed worker');
  });
});

describe('MARKABLE_PAID_STATUSES — which rows "mark all paid" may touch (RP-08)', () => {
  it('never re-stamps an already-sent or reconciled row (its paid_at is the real send date)', () => {
    expect(MARKABLE_PAID_STATUSES).not.toContain('sent');
    expect(MARKABLE_PAID_STATUSES).not.toContain('reconciled');
  });

  it('covers every unpaid state so a normal period still marks in full', () => {
    expect([...MARKABLE_PAID_STATUSES].sort()).toEqual(['draft', 'failed', 'queued']);
  });
});

describe('arrears pay date — the value lockPeriod must NOT overwrite (RP-03/RP-66)', () => {
  // ponytail: no DB harness here — this pins the invariant that made the write
  // wrong (a period end is never a legal pay date), not the UPDATE payload
  // itself. A stub-client test would pin the payload; add one if this file ever
  // gets a fake Supabase client.
  it('pays the first half at month end and the second half on the 15th of the next month', () => {
    expect(periodFor('2026-03-01').payDate).toBe('2026-03-31');
    expect(periodFor('2026-03-16').payDate).toBe('2026-04-15');
  });

  it('always lands strictly AFTER the period end — so period_end can never be it', () => {
    for (const start of ['2026-03-01', '2026-03-16', '2026-12-16', '2024-02-01']) {
      const p = periodFor(start);
      expect(p.payDate > p.end).toBe(true);
    }
  });
});

describe('lockBlockedReason — work in the window the draft does not pay (F2/RP-22/RP-34)', () => {
  const ps = (workerId: string, name: string, units: number | null) => ({ workerId, name, units });
  const none = new Map<string, number>();

  it('allows the lock when nothing is pending and every session is captured', () => {
    expect(lockBlockedReason('regular', 0, [ps('w1', 'Ana', 8)], new Map([['w1', 8]]))).toBeNull();
  });

  it('blocks on time entries still pending approval (F2)', () => {
    const reason = lockBlockedReason('regular', 3, [], none);
    expect(reason).toMatch(/3 time entries are still pending/i);
  });

  it('uses the singular for one pending entry', () => {
    expect(lockBlockedReason('regular', 1, [], none)).toMatch(/1 time entry is still pending/i);
  });

  it('blocks when a session landed after the last Calculate — more units than captured (RP-22)', () => {
    // Draft captured 8 sessions; a 9th approved, unpaid session is now in-window.
    const reason = lockBlockedReason('regular', 0, [ps('w1', 'Ana', 9)], new Map([['w1', 10]]));
    expect(reason).toContain('Ana');
    expect(reason).toMatch(/does not pay/i);
  });

  it('blocks a per-session worker with sessions but NO draft row at all (captured 0)', () => {
    expect(lockBlockedReason('regular', 0, [], new Map([['w9', 2]]))).toContain('Unnamed worker');
  });

  it('does not block when the draft captured at least what is unpaid in-window', () => {
    // Equal is fine, and a draft that captured MORE (sessions since paid
    // off-cycle) is a different problem — recomputeWorkerDraft already healed it.
    expect(lockBlockedReason('regular', 0, [ps('w1', 'Ana', 8)], new Map([['w1', 8]]))).toBeNull();
    expect(lockBlockedReason('regular', 0, [ps('w1', 'Ana', 8)], new Map([['w1', 3]]))).toBeNull();
  });

  it('never blocks an off-cycle batch — its window is a label, not its work (RP-34)', () => {
    // Today's unrelated pending time used to block the batch with a message
    // telling the admin to recalculate something the UI cannot recalculate.
    expect(lockBlockedReason('off_cycle', 7, [], new Map([['w1', 5]]))).toBeNull();
  });
});

describe('lockWarningReason — rows the admin must acknowledge before locking (RP-18)', () => {
  const row = (
    name: string,
    over: Partial<{ inactive: boolean; payoutMethod: string | null }>,
  ) => ({
    name,
    inactive: false,
    payoutMethod: 'wise',
    ...over,
  });

  it('is silent when every row is active and has a payout method', () => {
    expect(lockWarningReason([row('Ana', {}), row('Ben', {})], false)).toBeNull();
  });

  it('names an inactive contractor — the row that used to lock without a word', () => {
    const reason = lockWarningReason([row('Ana', {}), row('Ben', { inactive: true })], false);
    expect(reason).toContain('Ben');
    expect(reason).not.toContain('Ana');
    expect(reason).toMatch(/1 inactive contractor/i);
  });

  it('names a row with no payout method', () => {
    expect(lockWarningReason([row('Ana', { payoutMethod: null })], false)).toMatch(
      /no payout method.*Ana/i,
    );
  });

  it('reports both kinds at once', () => {
    const reason = lockWarningReason(
      [row('Ana', { inactive: true }), row('Ben', { payoutMethod: null })],
      false,
    );
    expect(reason).toMatch(/inactive/i);
    expect(reason).toMatch(/no payout method/i);
  });

  it('stays silent once the caller has confirmed — this is a warning, not a block', () => {
    expect(
      lockWarningReason([row('Ana', { inactive: true, payoutMethod: null })], true),
    ).toBeNull();
  });
});

describe('applyGrossOverride — a gross override stays revertible (RP-07)', () => {
  it('captures the engine gross on the first override', () => {
    expect(
      applyGrossOverride({ grossPhp: 18182, computedGrossPhp: null, note: null }, 15000),
    ).toEqual({
      grossPhp: 15000,
      computedGrossPhp: 18182,
      note: 'Gross manually overridden (computed 18182)',
    });
  });

  it('does NOT recapture on a second save — the bug that erased the true figure', () => {
    // Row already overridden to 15000; the debounced save fires again.
    const again = applyGrossOverride(
      {
        grossPhp: 15000,
        computedGrossPhp: 18182,
        note: 'Gross manually overridden (computed 18182)',
      },
      15000,
    );
    expect(again.computedGrossPhp).toBe(18182);
    expect(again.note).toBe('Gross manually overridden (computed 18182)');
  });

  it('restores the engine gross when the override is cleared, and drops the marker', () => {
    expect(
      applyGrossOverride(
        {
          grossPhp: 15000,
          computedGrossPhp: 18182,
          note: 'Gross manually overridden (computed 18182)',
        },
        null,
      ),
    ).toEqual({
      grossPhp: 18182,
      computedGrossPhp: null,
      note: null,
    });
  });

  it('re-overriding after a revert captures the restored gross afresh', () => {
    const cleared = applyGrossOverride(
      {
        grossPhp: 15000,
        computedGrossPhp: 18182,
        note: 'Gross manually overridden (computed 18182)',
      },
      null,
    );
    expect(applyGrossOverride(cleared, 12000).computedGrossPhp).toBe(18182);
  });

  it('clearing a row that was never overridden leaves the gross alone', () => {
    expect(
      applyGrossOverride({ grossPhp: 18182, computedGrossPhp: null, note: null }, null),
    ).toEqual({
      grossPhp: 18182,
      computedGrossPhp: null,
      note: null,
    });
  });

  it('keeps a note it did not write — 287 prod rows are a Hubstaff import, not an override', () => {
    // Every debounced save sends grossPhpOverride:null for a non-overridden row,
    // so a blanket `note: null` here wiped the row's provenance on any edit.
    const historical = 'Historical import (Hubstaff daily report)';
    expect(
      applyGrossOverride({ grossPhp: 18182, computedGrossPhp: null, note: historical }, null).note,
    ).toBe(historical);
  });
});

describe('unpayablePeriodReason — money moves only on a locked run (RP-52)', () => {
  it('allows marking on a locked period, and on a paid one (re-mark / reversal)', () => {
    expect(unpayablePeriodReason(['locked'])).toBeNull();
    expect(unpayablePeriodReason(['paid'])).toBeNull();
    expect(unpayablePeriodReason(['locked', 'paid'])).toBeNull();
    expect(unpayablePeriodReason([])).toBeNull();
  });

  it('refuses an OPEN period — its amounts are still being rewritten', () => {
    const reason = unpayablePeriodReason(['open']);
    expect(reason).toMatch(/only be marked once their period is locked/i);
    expect(reason).toContain('open');
  });

  it('refuses a mixed selection rather than paying the locked half', () => {
    expect(unpayablePeriodReason(['locked', 'open'])).not.toBeNull();
  });

  it('never lets "open" into the payable set', () => {
    expect(PAYABLE_PERIOD_STATES).not.toContain('open');
  });
});

describe('composeNetCentavos — net for the surgical off-cycle write (RP-20)', () => {
  const components = {
    paymentId: 'p1',
    grossPhp: 20000,
    haPhp: 1000,
    t13Php: 500,
    pddPhp: 250,
    bonusPhp: 100,
    miscItems: [
      { kind: 'other_earns', amount: 300 },
      { kind: 'deduction', amount: 200 },
    ],
  };

  it('sums the row’s own components plus the ledger total (deductions subtract)', () => {
    // 20000 + 1000 + 500 + 250 + 100 + 300 − 200 + 750 = 22700 PHP
    expect(composeNetCentavos(components, centavos(75_000))).toBe(2_270_000);
  });

  it('carries the manual adjustments through — that is the whole point of not rebuilding', () => {
    const bare = { ...components, miscItems: [], bonusPhp: 0, pddPhp: 0 };
    expect(composeNetCentavos(components, centavos(0))).toBeGreaterThan(
      composeNetCentavos(bare, centavos(0)),
    );
  });

  it('treats a null gross (no rate) as zero rather than NaN-ing the net', () => {
    expect(composeNetCentavos({ ...components, grossPhp: null }, centavos(0))).toBe(195_000);
  });
});

describe('preferredOpenDraft — which period /payroll opens on (RP-25)', () => {
  const p = (periodStart: string, state: string, contractorCount: number, kind = 'regular') => ({
    periodStart,
    state,
    contractorCount,
    kind,
  });

  // Summaries arrive period_start DESC — the in-progress period first.
  const marchList = [p('2026-03-16', 'open', 42), p('2026-03-01', 'open', 40)];

  it('prefers the ARREARS draft over the newer in-progress one seeded by the legacy app', () => {
    expect(preferredOpenDraft(marchList, '2026-03-01')?.periodStart).toBe('2026-03-01');
  });

  it('falls back to the newest open draft that has statements', () => {
    // Arrears period already locked → not a candidate.
    const list = [p('2026-03-16', 'open', 42), p('2026-03-01', 'locked', 40)];
    expect(preferredOpenDraft(list, '2026-03-01')?.periodStart).toBe('2026-03-16');
  });

  it('falls back to any open draft when none has statements yet', () => {
    expect(preferredOpenDraft([p('2026-03-16', 'open', 0)], '2026-03-01')?.periodStart).toBe(
      '2026-03-16',
    );
  });

  it('never lands on an off-cycle batch — periodFor() cannot represent its today–today label', () => {
    expect(preferredOpenDraft([p('2026-03-22', 'open', 3, 'off_cycle')], '2026-03-01')).toBeNull();
  });

  it('returns null with nothing open, so the caller falls back to the arrears period', () => {
    expect(preferredOpenDraft([p('2026-03-01', 'paid', 40)], '2026-03-01')).toBeNull();
  });
});

describe('officeToday — the off-cycle batch label is the office day, not UTC (RP-67)', () => {
  it('is still the SAME New York day for a late-evening create that UTC calls tomorrow', () => {
    // 2026-03-22 21:30 America/New_York = 2026-03-23T01:30Z.
    expect(officeToday(new Date('2026-03-23T01:30:00Z'))).toBe('2026-03-22');
  });

  it('rolls over with New York, not with UTC midnight', () => {
    expect(officeToday(new Date('2026-03-23T03:59:00Z'))).toBe('2026-03-22'); // 23:59 EDT
    expect(officeToday(new Date('2026-03-23T04:01:00Z'))).toBe('2026-03-23'); // 00:01 EDT
  });

  it('emits a plain ISO date the pay_periods date columns accept', () => {
    expect(officeToday(new Date('2026-07-04T15:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('selectAll — the paging fetchApprovedTime now uses instead of truncating (RP-11)', () => {
  /** A server that never returns more than `cap` rows per request, whatever range is asked for. */
  const capped = (total: number, cap: number) => (from: number, to: number) =>
    Promise.resolve({
      data: Array.from(
        { length: Math.max(0, Math.min(to - from + 1, cap, total - from)) },
        (_, i) => ({
          id: from + i,
        }),
      ),
      error: null as { message: string } | null,
    });

  it('returns every row when the deployed cap is below the page size (the 1,000-row cliff)', async () => {
    const rows = await selectAll(capped(2500, 1000), 'time_entries');
    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500); // no repeats, no gaps
  });

  it('is still correct when the server caps lower than we ask for', async () => {
    const rows = await selectAll(capped(2500, 300), 'time_entries');
    expect(rows).toHaveLength(2500);
  });

  it('throws (never silently short-changes the calc) when a page errors', async () => {
    await expect(
      selectAll(() => Promise.resolve({ data: null, error: { message: 'boom' } }), 'time_entries'),
    ).rejects.toThrow('time_entries: boom');
  });
});

describe('mergeManualColumns — a single-row rebuild keeps what a human typed (RP-20)', () => {
  /** What the engine just produced for one worker: gross 20,000, nothing manual. */
  const draft = {
    worker_id: 'w1',
    contract: 'FT',
    pay_basis: null,
    units: null,
    expected_hours: 88,
    worked_hours: 88,
    performance_ratio: 1,
    rate_php: 20000,
    gross_php: 20000,
    health_allowance_php: 0,
    thirteenth_month_php: 0,
    pdd_lunch_php: 0,
    bonus_php: 0,
    deduction_php: 0,
    off_cycle_php: 1500,
    net_php: 21500,
    misc_items: [],
    computed_gross_php: null,
    fx_rate: null,
    payout_currency: 'PHP' as const,
    payout_amount: 21500,
    payout_method: 'wise',
    status: 'draft' as const,
  };

  /** The stored row the rebuild is about to overwrite. */
  const stored = {
    paymentId: 'p1',
    grossPhp: 20000,
    haPhp: 0,
    t13Php: 0,
    pddPhp: 250,
    bonusPhp: 3000,
    miscItems: [{ kind: 'other_earns', amount: 500 }],
    computedGrossPhp: null,
    note: null,
  };

  it('keeps the engine draft untouched when there is no stored row yet', () => {
    expect(mergeManualColumns(draft, null)).toEqual(draft);
  });

  it('carries bonus, PDD and Misc across the rebuild and re-sums net', () => {
    const merged = mergeManualColumns(draft, stored);
    expect(merged.bonus_php).toBe(3000);
    expect(merged.pdd_lunch_php).toBe(250);
    expect(merged.misc_items).toEqual([{ kind: 'other_earns', amount: 500 }]);
    // 20000 gross + 250 pdd + 3000 bonus + 500 misc + 1500 off-cycle
    expect(merged.net_php).toBe(25250);
    expect(merged.payout_amount).toBe(25250);
  });

  it('lets the engine own gross when the row was never overridden', () => {
    // The rebuild exists BECAUSE gross moved (a session was just paid/freed).
    const merged = mergeManualColumns({ ...draft, gross_php: 18000 }, stored);
    expect(merged.gross_php).toBe(18000);
    expect(merged.computed_gross_php).toBeNull();
  });

  it('preserves a gross override and re-arms ↺ against the NEW engine gross', () => {
    const overridden = { ...stored, grossPhp: 15000, computedGrossPhp: 20000 };
    const merged = mergeManualColumns({ ...draft, gross_php: 19000 }, overridden);
    expect(merged.gross_php).toBe(15000); // the human's figure still pays
    expect(merged.computed_gross_php).toBe(19000); // revert target follows the engine
    expect(merged.note).toBe('Gross manually overridden (computed 19000)');
    // net is built from the OVERRIDE: 15000 + 250 + 3000 + 500 + 1500
    expect(merged.net_php).toBe(20250);
  });

  it('leaves a non-override note alone (287 prod rows carry import prose)', () => {
    const imported = { ...stored, note: 'Historical import (Hubstaff daily report)' };
    expect(mergeManualColumns(draft, imported).note).toBeUndefined();
  });
});
