import { describe, expect, it } from 'vitest';
import { isAllowedEmailForDomains, parseAllowedDomains } from '@/lib/auth/allowed-domains';

describe('parseAllowedDomains', () => {
  it('trims, lower-cases, and drops empties from a comma list', () => {
    expect(parseAllowedDomains('abckidsny.com, ABBILABS.com ,')).toEqual([
      'abckidsny.com',
      'abbilabs.com',
    ]);
  });
  it('handles a single domain', () => {
    expect(parseAllowedDomains('abckidsny.com')).toEqual(['abckidsny.com']);
  });
});

describe('isAllowedEmailForDomains', () => {
  const DOMAINS = ['abckidsny.com', 'abbilabs.com'];

  it('accepts an allowed domain regardless of casing/whitespace', () => {
    expect(isAllowedEmailForDomains('a@abckidsny.com', DOMAINS)).toBe(true);
    expect(isAllowedEmailForDomains('A@ABCKIDSNY.COM', DOMAINS)).toBe(true);
    expect(isAllowedEmailForDomains('  user@abbilabs.com  ', DOMAINS)).toBe(true);
  });

  it('rejects other domains', () => {
    expect(isAllowedEmailForDomains('a@gmail.com', DOMAINS)).toBe(false);
  });

  it('rejects subdomains and look-alikes (exact match only)', () => {
    expect(isAllowedEmailForDomains('a@sub.abckidsny.com', DOMAINS)).toBe(false);
    expect(isAllowedEmailForDomains('a@evil-abckidsny.com', DOMAINS)).toBe(false);
    expect(isAllowedEmailForDomains('a@abckidsny.com.evil.com', DOMAINS)).toBe(false);
  });

  it('rejects malformed addresses', () => {
    for (const bad of [
      '',
      'noatsign',
      'x@',
      '@abckidsny.com',
      'x@abckidsny',
      'a b@abckidsny.com',
    ]) {
      expect(isAllowedEmailForDomains(bad, DOMAINS)).toBe(false);
    }
  });

  it('honors explicit exceptions even off-domain', () => {
    expect(isAllowedEmailForDomains('founder@gmail.com', DOMAINS, ['founder@gmail.com'])).toBe(
      true,
    );
  });

  it('matches an exception case-insensitively', () => {
    expect(isAllowedEmailForDomains('Founder@Gmail.com', DOMAINS, ['FOUNDER@gmail.com'])).toBe(
      true,
    );
  });
});
