import { safeNext } from '@/lib/auth/safe-next';
import { describe, expect, it } from 'vitest';

describe('safeNext', () => {
  it('preserves same-site path-only targets', () => {
    for (const ok of ['/', '/portal', '/overview', '/portal?next=x', '/a/b/c']) {
      expect(safeNext(ok)).toBe(ok);
    }
  });

  it('collapses protocol-relative / backslash / absolute / scheme targets to /', () => {
    for (const bad of [
      '//evil.com',
      '/\\evil.com',
      'https://evil.com',
      'http://evil.com',
      'javascript:alert(1)',
      'evil.com',
      '  //evil.com',
    ]) {
      expect(safeNext(bad)).toBe('/');
    }
  });

  it('defaults null/undefined to /', () => {
    expect(safeNext(null)).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });
});
