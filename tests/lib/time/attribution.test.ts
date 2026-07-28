/**
 * Tests for name-attribution helpers (src/lib/time/attribution.ts).
 */

import { describe, expect, it } from 'vitest';
import type { RosterLink } from '@/lib/time/attribution';
import { attributionStatus, buildMatchIndex, matchName } from '@/lib/time/attribution';

const roster: RosterLink[] = [
  {
    workerId: 'w1',
    hubstaffName: 'Alice Smith',
    firstName: 'Alice',
    lastName: 'Smith',
    isInactive: false,
  },
  {
    workerId: 'w2',
    hubstaffName: 'Bob Reyes',
    firstName: 'Bob',
    lastName: 'Reyes',
    isInactive: false,
  },
  {
    workerId: 'w3',
    hubstaffName: null,
    firstName: 'Maria',
    lastName: 'Clara',
    isInactive: true,
  },
];

describe('buildMatchIndex + matchName', () => {
  const idx = buildMatchIndex(roster);

  it('matches on exact hubstaff name', () => {
    const hit = matchName('Alice Smith', idx);
    expect(hit?.workerId).toBe('w1');
  });

  it('matches name in any word order (strict key)', () => {
    const hit = matchName('Smith Alice', idx);
    expect(hit?.workerId).toBe('w1');
  });

  it('matches on loose first+last key', () => {
    // "Bob Middle Reyes" loose key → "bob reyes"
    const hit = matchName('Bob Middle Reyes', idx);
    expect(hit?.workerId).toBe('w2');
  });

  it('returns null for unmatched names', () => {
    expect(matchName('Unknown Person', idx)).toBeNull();
  });

  it('reports inactive status', () => {
    // Maria Clara has no hubstaff_name, match via real name
    const hit = matchName('Clara Maria', idx);
    expect(hit?.isInactive).toBe(true);
  });
});

describe('attributionStatus', () => {
  const idx = buildMatchIndex(roster);

  it('returns matched for active workers', () => {
    expect(attributionStatus('Alice Smith', idx)).toBe('matched');
  });

  it('returns inactive for inactive workers', () => {
    expect(attributionStatus('Maria Clara', idx)).toBe('inactive');
  });

  it('returns unmatched for unknown names', () => {
    expect(attributionStatus('Nobody Here', idx)).toBe('unmatched');
  });
});

// ── RP-39: a shared name key decides who gets paid — don't guess it ──────────
describe('duplicate-name ambiguity', () => {
  const dupes: RosterLink[] = [
    {
      workerId: 'w1',
      hubstaffName: null,
      firstName: 'Maria',
      middleName: 'A.',
      lastName: 'Santos',
      isInactive: false,
    },
    {
      workerId: 'w2',
      hubstaffName: null,
      firstName: 'Maria',
      middleName: 'L.',
      lastName: 'Santos',
      isInactive: false,
    },
  ];
  const idx = buildMatchIndex(dupes);

  it('refuses a name that two workers answer to, instead of first-wins', () => {
    // Both real names key to "maria santos" — whoever was indexed first used to
    // silently collect the other's hours.
    expect(matchName('Maria Santos', idx)).toBeNull();
    expect(attributionStatus('Maria Santos', idx)).toBe('ambiguous');
  });

  it('separates ambiguous from unmatched so the banner can say which', () => {
    expect(attributionStatus('Nobody Here', idx)).toBe('unmatched');
  });

  it('still resolves the spellings that name exactly one of them', () => {
    expect(matchName('Maria A. Santos', idx)?.workerId).toBe('w1');
    expect(matchName('Maria L. Santos', idx)?.workerId).toBe('w2');
    expect(attributionStatus('Maria L. Santos', idx)).toBe('matched');
  });

  it('does not flag one worker indexed under several of their own names', () => {
    const idxSolo = buildMatchIndex([
      {
        workerId: 'w1',
        hubstaffName: 'Alice Smith',
        firstName: 'Alice',
        middleName: null,
        lastName: 'Smith',
        isInactive: false,
      },
    ]);
    expect(matchName('Alice Smith', idxSolo)?.workerId).toBe('w1');
  });
});
