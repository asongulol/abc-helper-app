/**
 * Pure cron-secret check (no env import, so it's trivially testable). Fail-closed:
 * a request is only valid when a secret is configured AND the header matches it.
 */
export const cronSecretOk = (got: string | null, expected: string | undefined): boolean =>
  !!expected && typeof got === 'string' && got === expected;
