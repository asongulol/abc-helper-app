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
