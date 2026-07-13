import { describe, expect, it } from 'vitest';
import { type OpenDraft, resolveOpenDraftForDate } from '@/db/queries/payroll';

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
