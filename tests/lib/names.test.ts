import { describe, expect, it } from 'vitest';
import { fullName, looseKey, nameKey, nameTokens } from '@/lib/names';

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
