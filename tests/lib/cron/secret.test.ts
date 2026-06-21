import { describe, expect, it } from 'vitest';
import { cronSecretOk } from '@/lib/cron/secret';

describe('cronSecretOk', () => {
  it('fails closed when no secret is configured', () => {
    expect(cronSecretOk('anything', undefined)).toBe(false);
    expect(cronSecretOk('anything', '')).toBe(false);
  });

  it('rejects a missing or mismatched header', () => {
    expect(cronSecretOk(null, 's3cret')).toBe(false);
    expect(cronSecretOk('wrong', 's3cret')).toBe(false);
    expect(cronSecretOk('', 's3cret')).toBe(false);
  });

  it('accepts an exact match', () => {
    expect(cronSecretOk('s3cret', 's3cret')).toBe(true);
  });
});
