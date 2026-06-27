import { describe, expect, it } from 'vitest';
import { isPrefetchRequest } from '@/lib/http/prefetch';

describe('isPrefetchRequest', () => {
  it('is true for a full-route prefetch (next-router-prefetch: 1)', () => {
    expect(isPrefetchRequest(new Headers({ 'next-router-prefetch': '1' }))).toBe(true);
  });

  it('is true for a segment/PPR prefetch (next-router-segment-prefetch present)', () => {
    expect(isPrefetchRequest(new Headers({ 'next-router-segment-prefetch': '/_tree' }))).toBe(true);
  });

  it('is false for a real RSC navigation (rsc header, no prefetch header)', () => {
    expect(isPrefetchRequest(new Headers({ rsc: '1' }))).toBe(false);
  });

  it('is false for a plain document request', () => {
    expect(isPrefetchRequest(new Headers())).toBe(false);
  });

  it('is false when the prefetch header carries an unexpected value', () => {
    // Guards the strict `=== '1'` check so the gate is only skipped on a genuine
    // prefetch signal, not any presence of the header.
    expect(isPrefetchRequest(new Headers({ 'next-router-prefetch': '0' }))).toBe(false);
  });
});
