import { describe, expect, it } from 'vitest';
import { shouldSendDigestToday } from '@/lib/documents/digest-schedule';

// Fixed UTC anchors (noon to avoid TZ edges):
//   2026-06-20 = Saturday (dow 6)
//   2026-06-21 = Sunday   (dow 0)
//   2026-06-22 = Monday   (dow 1)
//   2026-06-23 = Tuesday  (dow 2)
//   2026-06-26 = Friday   (dow 5)
const sat = new Date('2026-06-20T12:00:00Z');
const sun = new Date('2026-06-21T12:00:00Z');
const mon = new Date('2026-06-22T12:00:00Z');
const tue = new Date('2026-06-23T12:00:00Z');
const fri = new Date('2026-06-26T12:00:00Z');

describe('shouldSendDigestToday', () => {
  it('daily sends every day', () => {
    for (const d of [sat, sun, mon, tue, fri]) {
      expect(shouldSendDigestToday('daily', d)).toBe(true);
    }
  });

  it('weekdays sends Mon–Fri, not weekends', () => {
    expect(shouldSendDigestToday('weekdays', mon)).toBe(true);
    expect(shouldSendDigestToday('weekdays', fri)).toBe(true);
    expect(shouldSendDigestToday('weekdays', sat)).toBe(false);
    expect(shouldSendDigestToday('weekdays', sun)).toBe(false);
  });

  it('weekly sends only on Monday', () => {
    expect(shouldSendDigestToday('weekly', mon)).toBe(true);
    expect(shouldSendDigestToday('weekly', tue)).toBe(false);
    expect(shouldSendDigestToday('weekly', sat)).toBe(false);
  });

  it('fails open (sends) for an unrecognized frequency', () => {
    expect(shouldSendDigestToday('monthly', tue)).toBe(true);
    expect(shouldSendDigestToday('', sat)).toBe(true);
  });
});
