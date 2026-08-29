import { describe, expect, it } from 'vitest';
import { MOTTO_SUGGESTIONS, mottoLanguageFor, suggestMottos } from '@/lib/portal/motto';

describe('mottoLanguageFor', () => {
  it('maps areas to their language', () => {
    expect(mottoLanguageFor('123 Osmeña Blvd, Cebu City')).toBe('cebuano');
    expect(mottoLanguageFor('Jaro, Iloilo City')).toBe('hiligaynon');
    expect(mottoLanguageFor('Vigan, Ilocos Sur')).toBe('ilocano');
  });

  it('Cagayan de Oro is Cebuano, not Ilocano-area Cagayan', () => {
    expect(mottoLanguageFor('Cagayan de Oro City, Misamis Oriental')).toBe('cebuano');
  });

  it('defaults to Tagalog for Manila, unknown, or missing addresses', () => {
    expect(mottoLanguageFor('Quezon City, Metro Manila')).toBe('tagalog');
    expect(mottoLanguageFor('somewhere else entirely')).toBe('tagalog');
    expect(mottoLanguageFor(null)).toBe('tagalog');
    expect(mottoLanguageFor('')).toBe('tagalog');
  });
});

describe('suggestMottos', () => {
  it('returns the suggestion set for the matched language', () => {
    expect(suggestMottos('Bacolod City')).toEqual(MOTTO_SUGGESTIONS.hiligaynon);
    expect(suggestMottos(null)).toEqual(MOTTO_SUGGESTIONS.tagalog);
  });
});
