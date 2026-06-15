import { isOAuthSignIn } from '@/lib/auth/oauth-provider';
import { describe, expect, it } from 'vitest';

describe('isOAuthSignIn', () => {
  it('is false for an email-provider user (contractor password / recovery)', () => {
    expect(isOAuthSignIn({ app_metadata: { provider: 'email' } })).toBe(false);
  });

  it('is true for a google provider', () => {
    expect(isOAuthSignIn({ app_metadata: { provider: 'google' } })).toBe(true);
  });

  it('is true when the providers array contains a non-email entry', () => {
    expect(
      isOAuthSignIn({ app_metadata: { provider: 'email', providers: ['email', 'google'] } }),
    ).toBe(true);
  });

  it('is true when an identity uses a non-email provider', () => {
    expect(
      isOAuthSignIn({ app_metadata: { provider: 'email' }, identities: [{ provider: 'google' }] }),
    ).toBe(true);
  });

  it('is false with empty/undefined metadata', () => {
    expect(isOAuthSignIn({})).toBe(false);
    expect(isOAuthSignIn({ app_metadata: null, identities: null })).toBe(false);
  });
});
