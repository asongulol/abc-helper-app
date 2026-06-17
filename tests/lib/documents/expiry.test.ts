/**
 * Unit tests for src/lib/documents/expiry.ts
 *
 * Pure-rule → test mapping:
 *   daysUntil negative (overdue)         → 'daysUntil: negative when date is past'
 *   daysUntil zero (today)               → 'daysUntil: 0 when date is today'
 *   daysUntil positive (future)          → 'daysUntil: positive when date is future'
 *   overdue classification               → 'classifyExpiry: days<0 goes to overdue'
 *   withinDays boundary (exact)          → 'classifyExpiry: day=withinDays is expiringSoon'
 *   withinDays boundary (outside)        → 'classifyExpiry: day=withinDays+1 is dropped'
 *   day=0 is expiringSoon                → 'classifyExpiry: day=0 is expiringSoon'
 *   empty input                          → 'classifyExpiry: empty input returns empty lists'
 *   sorting overdue asc                  → 'classifyExpiry: overdue sorted by expiresOn asc'
 *   sorting expiringSoon asc             → 'classifyExpiry: expiringSoon sorted by expiresOn asc'
 *   kind label mapping                   → 'classifyExpiry: kind is mapped to human label'
 *   unmapped kind falls back to raw      → 'classifyExpiry: unknown kind falls back to raw value'
 *   countExpiryBanner counts             → 'countExpiryBanner: counts overdue and expiringSoon'
 *   countExpiryBanner skips null expiry  → 'countExpiryBanner: null expiresOn is skipped'
 *   default withinDays=30                → 'classifyExpiry: default withinDays is 30'
 */

import { describe, expect, it } from 'vitest';
import { classifyExpiry, countExpiryBanner, daysUntil } from '@/lib/documents/expiry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TODAY = new Date('2026-06-13T00:00:00Z');

function makeDoc(
  expiresOn: string,
  kind = 'ic_agreement',
): {
  workerName: string;
  companyName: string;
  kind: string;
  title: string | null;
  expiresOn: string;
} {
  return {
    workerName: 'Ana Reyes',
    companyName: 'ABC Kids',
    kind,
    title: null,
    expiresOn,
  };
}

// ---------------------------------------------------------------------------
// daysUntil
// ---------------------------------------------------------------------------

describe('daysUntil', () => {
  it('negative when date is past', () => {
    expect(daysUntil('2026-06-12', TODAY)).toBe(-1);
  });

  it('0 when date is today', () => {
    expect(daysUntil('2026-06-13', TODAY)).toBe(0);
  });

  it('positive when date is future', () => {
    expect(daysUntil('2026-07-13', TODAY)).toBe(30);
  });

  it('large past gap', () => {
    expect(daysUntil('2025-06-13', TODAY)).toBe(-365);
  });
});

// ---------------------------------------------------------------------------
// classifyExpiry
// ---------------------------------------------------------------------------

describe('classifyExpiry', () => {
  it('empty input returns empty lists', () => {
    const result = classifyExpiry([], TODAY);
    expect(result.overdue).toHaveLength(0);
    expect(result.expiringSoon).toHaveLength(0);
  });

  it('days<0 goes to overdue', () => {
    const result = classifyExpiry([makeDoc('2026-06-12')], TODAY);
    expect(result.overdue).toHaveLength(1);
    expect(result.expiringSoon).toHaveLength(0);
    expect(result.overdue[0]?.days).toBe(-1);
  });

  it('day=0 is expiringSoon', () => {
    const result = classifyExpiry([makeDoc('2026-06-13')], TODAY);
    expect(result.expiringSoon).toHaveLength(1);
    expect(result.overdue).toHaveLength(0);
    expect(result.expiringSoon[0]?.days).toBe(0);
  });

  it('day=withinDays is expiringSoon (boundary inclusive)', () => {
    // 30 days from today = 2026-07-13
    const result = classifyExpiry([makeDoc('2026-07-13')], TODAY, 30);
    expect(result.expiringSoon).toHaveLength(1);
    expect(result.expiringSoon[0]?.days).toBe(30);
  });

  it('day=withinDays+1 is dropped (outside window)', () => {
    // 31 days from today = 2026-07-14
    const result = classifyExpiry([makeDoc('2026-07-14')], TODAY, 30);
    expect(result.expiringSoon).toHaveLength(0);
    expect(result.overdue).toHaveLength(0);
  });

  it('default withinDays is 30', () => {
    const at30 = classifyExpiry([makeDoc('2026-07-13')], TODAY);
    const at31 = classifyExpiry([makeDoc('2026-07-14')], TODAY);
    expect(at30.expiringSoon).toHaveLength(1);
    expect(at31.expiringSoon).toHaveLength(0);
  });

  it('overdue sorted by expiresOn asc (most overdue last)', () => {
    const result = classifyExpiry(
      [makeDoc('2026-06-10'), makeDoc('2026-06-05'), makeDoc('2026-06-12')],
      TODAY,
    );
    expect(result.overdue.map((e) => e.expiresOn)).toEqual([
      '2026-06-05',
      '2026-06-10',
      '2026-06-12',
    ]);
  });

  it('expiringSoon sorted by expiresOn asc (soonest first)', () => {
    const result = classifyExpiry(
      [makeDoc('2026-06-20'), makeDoc('2026-06-15'), makeDoc('2026-06-25')],
      TODAY,
    );
    expect(result.expiringSoon.map((e) => e.expiresOn)).toEqual([
      '2026-06-15',
      '2026-06-20',
      '2026-06-25',
    ]);
  });

  it('kind is mapped to human label', () => {
    const result = classifyExpiry([makeDoc('2026-06-12', 'ic_agreement')], TODAY);
    expect(result.overdue[0]?.kind).toBe('IC Agreement');
  });

  it('unknown kind falls back to raw value', () => {
    const result = classifyExpiry([makeDoc('2026-06-12', 'custom_thing')], TODAY);
    expect(result.overdue[0]?.kind).toBe('custom_thing');
  });

  it('mixes overdue and expiringSoon correctly', () => {
    const result = classifyExpiry(
      [
        makeDoc('2026-06-10'), // overdue
        makeDoc('2026-06-13'), // today = expiringSoon
        makeDoc('2026-07-14'), // 31d = dropped
      ],
      TODAY,
      30,
    );
    expect(result.overdue).toHaveLength(1);
    expect(result.expiringSoon).toHaveLength(1);
  });

  it('title null becomes empty string in entry', () => {
    const doc = {
      workerName: 'Ana',
      companyName: 'Acme',
      kind: 'w8ben',
      title: null,
      expiresOn: '2026-06-12',
    };
    const result = classifyExpiry([doc], TODAY);
    expect(result.overdue[0]?.title).toBe('');
  });

  it('title is preserved when non-null', () => {
    const doc = {
      workerName: 'Ana',
      companyName: 'Acme',
      kind: 'w8ben',
      title: 'My W8',
      expiresOn: '2026-06-12',
    };
    const result = classifyExpiry([doc], TODAY);
    expect(result.overdue[0]?.title).toBe('My W8');
  });
});

// ---------------------------------------------------------------------------
// countExpiryBanner
// ---------------------------------------------------------------------------

describe('countExpiryBanner', () => {
  it('counts overdue and expiringSoon', () => {
    const docs = [
      { expiresOn: '2026-06-10' }, // overdue
      { expiresOn: '2026-06-13' }, // today = expiringSoon
      { expiresOn: '2026-07-13' }, // day=30 = expiringSoon
      { expiresOn: '2026-07-14' }, // day=31 = dropped
    ];
    const result = countExpiryBanner(docs, TODAY, 30);
    expect(result.overdueCount).toBe(1);
    expect(result.expiringSoonCount).toBe(2);
  });

  it('null expiresOn is skipped', () => {
    const docs = [{ expiresOn: null }, { expiresOn: null }];
    const result = countExpiryBanner(docs, TODAY);
    expect(result.overdueCount).toBe(0);
    expect(result.expiringSoonCount).toBe(0);
  });

  it('empty input returns zeros', () => {
    const result = countExpiryBanner([], TODAY);
    expect(result.overdueCount).toBe(0);
    expect(result.expiringSoonCount).toBe(0);
  });
});
