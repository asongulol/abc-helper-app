import { describe, expect, it } from 'vitest';
import { recipientMatchesTerm } from '@/lib/wise/recipient-search';

describe('recipientMatchesTerm', () => {
  it('matches a Wisetag against the space-stripped name', () => {
    // The whole reason the "By name / tag" route works for Wisetags.
    expect(recipientMatchesTerm('Lea Theresa Nueva B', null, '@leatheresanuevab')).toBe(true);
  });

  it('matches a plain name substring and email, case-insensitively', () => {
    expect(recipientMatchesTerm('Maria Dela Cruz', null, 'dela')).toBe(true);
    expect(recipientMatchesTerm('Maria', 'maria@example.com', 'EXAMPLE')).toBe(true);
  });

  it('does not match unrelated terms or an empty query', () => {
    expect(recipientMatchesTerm('Lea Theresa Nueva B', 'lea@x.com', 'jose')).toBe(false);
    expect(recipientMatchesTerm('Lea', null, '   @  ')).toBe(false);
  });
});
