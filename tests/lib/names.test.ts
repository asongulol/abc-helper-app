import { looseKey, nameKey, nameTokens } from '@/lib/names';
import { describe, expect, it } from 'vitest';

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
