import { describe, expect, it } from 'vitest';
import { type MatchTally, matchSummary } from '@/lib/wise/match-summary';

const tally = (over: Partial<MatchTally> = {}): MatchTally => ({
  scanned: 0,
  matched: 0,
  variances: 0,
  ambiguous: 0,
  noRecipient: 0,
  noTransfer: 0,
  dbWriteFailed: 0,
  unpaidLink: 0,
  wrongPeriod: 0,
  ...over,
});

describe('matchSummary', () => {
  it('never calls a zero-link run a success', () => {
    // The bug: these all rendered as green "Matched 0 transfer(s)." and the
    // operator read that as "it worked".
    for (const reason of [
      'ambiguous',
      'noRecipient',
      'noTransfer',
      'dbWriteFailed',
      'unpaidLink',
      'wrongPeriod',
    ] as const) {
      const s = matchSummary(tally({ scanned: 3, [reason]: 3 }));
      expect(s.tone).toBe('warn');
      expect(s.text).toContain('3');
      expect(s.text).not.toBe('Linked none of the 3 payment(s) scanned.');
    }
  });

  it('names every skipped row so the count adds up', () => {
    const s = matchSummary(
      tally({ scanned: 4, matched: 1, ambiguous: 1, noRecipient: 1, dbWriteFailed: 1 }),
    );
    expect(s.text).toBe(
      'Linked 1 of 4 payment(s) — 1 ambiguous (several Wise transfers fit), ' +
        '1 with no Wise recipient on file, 1 that failed to save.',
    );
  });

  it('counts a variance as linked but keeps it flagged', () => {
    const s = matchSummary(tally({ scanned: 2, matched: 1, variances: 1 }));
    expect(s.text).toBe('Linked 2 of 2 payment(s), 1 with an amount difference to review.');
    expect(s.tone).toBe('warn');
  });

  it('is a plain success only when everything linked cleanly', () => {
    expect(matchSummary(tally({ scanned: 2, matched: 2 }))).toEqual({
      text: 'Linked 2 of 2 payment(s).',
      tone: 'success',
    });
  });

  it('distinguishes "nothing to do" from "nothing worked"', () => {
    expect(matchSummary(tally()).tone).toBe('info');
    expect(matchSummary(tally({ scanned: 1, noTransfer: 1 })).tone).toBe('warn');
  });
});
