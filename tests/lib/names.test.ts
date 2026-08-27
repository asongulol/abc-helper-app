import { describe, expect, it } from 'vitest';
import { fullName, looseKey, matchesQuery, nameKey, nameTokens } from '@/lib/names';

describe('matchesQuery (⌘K palette + table filters)', () => {
  it('matches subsequences so "tisha" finds Trisha', () => {
    expect(matchesQuery('tisha', ['Trisha Ann Tagubaras'])).toBe(true);
    expect(matchesQuery('trisha', ['Trisha Ann Tagubaras'])).toBe(true);
  });

  it('every token must land in some value (tokens may hit different columns)', () => {
    expect(matchesQuery('trisha ability', ['Trisha Ann Tagubaras', 'Ability Builders'])).toBe(true);
    expect(matchesQuery('trisha zagado', ['Trisha Ann Tagubaras', 'Ability Builders'])).toBe(false);
  });

  it('is case-insensitive; empty query matches; null values are skipped', () => {
    expect(matchesQuery('TAGUBARAS', ['trisha ann tagubaras'])).toBe(true);
    expect(matchesQuery('  ', ['anything'])).toBe(true);
    expect(matchesQuery('x', [null, undefined])).toBe(false);
  });

  it('out-of-order characters do not match', () => {
    expect(matchesQuery('ahsit', ['Trisha'])).toBe(false);
  });
});

describe('fullName (display) — #037 one helper everywhere', () => {
  it('joins first + middle + last, skipping blanks', () => {
    expect(fullName({ firstName: 'Maria', middleName: 'Clara', lastName: 'Santos' })).toBe(
      'Maria Clara Santos',
    );
    expect(fullName({ firstName: 'Maria', middleName: null, lastName: 'Santos' })).toBe(
      'Maria Santos',
    );
    expect(fullName({ firstName: 'Cher' })).toBe('Cher');
    expect(fullName({})).toBe('');
  });
});

describe('name keys (legacy nameTokens/nameKey/looseKey ~4313)', () => {
  it('strict key is order- and middle-name-insensitive', () => {
    expect(nameKey('Manuella Brittany Gamboa')).toBe(nameKey('gamboa manuella brittany'));
    expect(nameKey('  Juan   Dela Cruz ')).toBe(nameKey('Dela Cruz Juan'));
  });

  it('strips accents, punctuation, and suffixes; expands Ma → Maria', () => {
    expect(nameTokens('José Rizal Jr.')).toEqual(['jose', 'rizal']);
    expect(nameTokens('Ma. Clara')).toEqual(['maria', 'clara']);
    expect(nameKey('Reyes, Ana III')).toBe('ana reyes');
  });

  it('loose key keeps first + last token only', () => {
    expect(looseKey('Manuella Brittany Gamboa')).toBe('manuella gamboa');
    expect(looseKey('Manuella Gamboa')).toBe('manuella gamboa');
    expect(looseKey('Cher')).toBe('cher');
    expect(looseKey('')).toBe('');
  });

  it('empty/null input yields empty key', () => {
    expect(nameKey(null)).toBe('');
    expect(nameKey(undefined)).toBe('');
    expect(nameTokens(null)).toEqual([]);
  });
});
