/**
 * Tests for the Hubstaff CSV parser (src/lib/time/csv.ts).
 * Mirrors the legacy verified parser behaviour.
 */

import { hmsToSeconds, isParseError, parseHubstaffCsv, parseRawCsv } from '@/lib/time/csv';
import { describe, expect, it } from 'vitest';

// ─── hmsToSeconds ─────────────────────────────────────────────────────────────

describe('hmsToSeconds', () => {
  it('parses H:MM:SS', () => {
    expect(hmsToSeconds('1:30:00')).toBe(5400);
    expect(hmsToSeconds('0:00:01')).toBe(1);
    expect(hmsToSeconds('8:00:00')).toBe(28800);
  });

  it('returns 0 for blank / zero sentinel', () => {
    expect(hmsToSeconds('')).toBe(0);
    expect(hmsToSeconds(null)).toBe(0);
    expect(hmsToSeconds(undefined)).toBe(0);
    expect(hmsToSeconds('0:00:00')).toBe(0);
  });

  it('handles two-digit hours', () => {
    expect(hmsToSeconds('10:15:30')).toBe(36930);
  });
});

// ─── parseRawCsv ─────────────────────────────────────────────────────────────

describe('parseRawCsv', () => {
  it('parses simple CSV', () => {
    const rows = parseRawCsv('a,b,c\n1,2,3');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles double-quote escaping', () => {
    const rows = parseRawCsv('"foo ""bar""","baz"\n');
    expect(rows[0]?.[0]).toBe('foo "bar"');
    expect(rows[0]?.[1]).toBe('baz');
  });

  it('handles CRLF line endings', () => {
    const rows = parseRawCsv('a,b\r\n1,2\r\n');
    expect(rows).toHaveLength(2);
  });

  it('skips blank rows', () => {
    const rows = parseRawCsv('a,b\n\n1,2\n\n');
    expect(rows).toHaveLength(2);
  });
});

// ─── parseHubstaffCsv ─────────────────────────────────────────────────────────

const SAMPLE_CSV = [
  'Client,Project,Member,2026-06-01,2026-06-02,Time off,Total worked,Activity',
  'ABC,Main,Alice Smith,1:00:00,2:00:00,0:00:00,3:00:00,72%',
  'ABC,Main,Bob Reyes,0:30:00,0:00:00,0:00:00,0:30:00,55%',
  ',,,,,,,', // totals/blank row — should be skipped
].join('\n');

describe('parseHubstaffCsv', () => {
  it('parses a valid Hubstaff daily report', () => {
    const result = parseHubstaffCsv(SAMPLE_CSV);
    expect(isParseError(result)).toBe(false);
    if (isParseError(result)) return;

    expect(result.dates).toEqual(['2026-06-01', '2026-06-02']);
    expect(result.members).toHaveLength(2);

    const alice = result.members.find((m) => m.name === 'Alice Smith');
    expect(alice).toBeDefined();
    expect(alice?.daySeconds['2026-06-01']).toBe(3600);
    expect(alice?.daySeconds['2026-06-02']).toBe(7200);
    expect(alice?.totalSeconds).toBe(10800);
    expect(alice?.activityPct).toBe(72);

    const bob = result.members.find((m) => m.name === 'Bob Reyes');
    expect(bob?.daySeconds['2026-06-01']).toBe(1800);
    expect(bob?.daySeconds['2026-06-02']).toBe(0);
  });

  it('returns an error for empty input', () => {
    expect(isParseError(parseHubstaffCsv(''))).toBe(true);
  });

  it('returns an error when Member column is absent', () => {
    const bad = 'Name,Date,Hours\nAlice,2026-06-01,1:00:00\n';
    const result = parseHubstaffCsv(bad);
    expect(isParseError(result)).toBe(true);
    if (isParseError(result)) {
      expect(result.message).toMatch(/Member/);
    }
  });

  it('returns an error when Time off / Total worked columns are absent', () => {
    const bad = 'Member,2026-06-01\nAlice Smith,1:00:00\n';
    const result = parseHubstaffCsv(bad);
    expect(isParseError(result)).toBe(true);
  });

  it('PTO seconds are always 0 for CSV imports', () => {
    const result = parseHubstaffCsv(SAMPLE_CSV);
    if (isParseError(result)) throw new Error('expected success');
    for (const m of result.members) {
      for (const v of Object.values(m.ptoSeconds)) {
        expect(v).toBe(0);
      }
    }
  });

  it('skipped rows count is correct', () => {
    const result = parseHubstaffCsv(SAMPLE_CSV);
    if (isParseError(result)) throw new Error('expected success');
    expect(result.skippedRows).toBeGreaterThanOrEqual(1);
  });
});
