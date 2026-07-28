import { describe, expect, it } from 'vitest';
import {
  type OpenDraft,
  resolveOpenDraftForDate,
  sessionIdsToRelease,
  sessionPaidWorkers,
} from '@/db/queries/payroll';

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
