/**
 * Unit tests for src/lib/documents/hiring-review.ts
 *
 * Pure-rule → test mapping:
 *   deduplication to latest per (worker,kind,side)   → 'deduplicates to latest by createdAt'
 *   pending bucket                                   → 'pending docs collected under worker'
 *   deferred bucket                                  → 'deferred docs collected when includeDeferred=true'
 *   deferred excluded when flag=false                → 'deferred excluded when includeDeferred=false'
 *   approved/needs_replacement skipped               → 'approved and needs_replacement are skipped'
 *   sort by worker name                              → 'contractors sorted alphabetically'
 *   doc label with side                              → 'docLabel includes side when non-null'
 *   doc label without side                           → 'docLabel omits side when null'
 *   empty input                                      → 'empty input returns zero counts'
 *   pendingContractors / deferredContractors split   → 'pendingContractors and deferredContractors are subsets'
 *   counts                                           → 'pendingDocs and deferredDocs are correct counts'
 *   multiple docs per worker                         → 'multiple pending docs per worker collected'
 */

import { describe, expect, it } from 'vitest';
import type { HiringDocInput } from '@/lib/documents/hiring-review';
import { classifyHiringReview, docLabel } from '@/lib/documents/hiring-review';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(
  workerId: string,
  kind: string,
  reviewStatus: string,
  createdAt: string,
  side: string | null = null,
): HiringDocInput {
  return {
    workerId,
    workerName: `Worker ${workerId}`,
    companyName: 'ABC Kids',
    workerEmail: `${workerId}@example.com`,
    kind,
    side,
    reviewStatus,
    createdAt,
  };
}

// ---------------------------------------------------------------------------
// docLabel
// ---------------------------------------------------------------------------

describe('docLabel', () => {
  it('returns mapped label without side when side is null', () => {
    expect(docLabel('resume', null)).toBe('Resume / CV');
  });

  it('appends side when non-null', () => {
    expect(docLabel('gov_id', 'front')).toBe('Gov ID / Passport (front)');
  });

  it('falls back to raw kind for unknown kind', () => {
    expect(docLabel('unknown_doc', null)).toBe('unknown_doc');
  });

  it('appends side even for unknown kind', () => {
    expect(docLabel('unknown_doc', 'back')).toBe('unknown_doc (back)');
  });
});

// ---------------------------------------------------------------------------
// classifyHiringReview
// ---------------------------------------------------------------------------

describe('classifyHiringReview', () => {
  it('empty input returns zero counts', () => {
    const result = classifyHiringReview([]);
    expect(result.pendingDocs).toBe(0);
    expect(result.deferredDocs).toBe(0);
    expect(result.contractors).toHaveLength(0);
  });

  it('pending docs collected under worker', () => {
    const inputs = [makeDoc('w1', 'resume', 'pending', '2026-06-01T00:00:00Z')];
    const result = classifyHiringReview(inputs);
    expect(result.pendingDocs).toBe(1);
    expect(result.pendingContractors).toHaveLength(1);
    expect(result.pendingContractors[0]?.pending).toContain('Resume / CV');
  });

  it('deferred docs collected when includeDeferred=true (default)', () => {
    const inputs = [makeDoc('w1', 'diploma', 'deferred', '2026-06-01T00:00:00Z')];
    const result = classifyHiringReview(inputs);
    expect(result.deferredDocs).toBe(1);
    expect(result.deferredContractors).toHaveLength(1);
  });

  it('deferred excluded when includeDeferred=false', () => {
    const inputs = [makeDoc('w1', 'diploma', 'deferred', '2026-06-01T00:00:00Z')];
    const result = classifyHiringReview(inputs, { includeDeferred: false });
    expect(result.deferredDocs).toBe(0);
    expect(result.deferredContractors).toHaveLength(0);
    expect(result.contractors).toHaveLength(0);
  });

  it('approved and needs_replacement are skipped', () => {
    const inputs = [
      makeDoc('w1', 'resume', 'approved', '2026-06-01T00:00:00Z'),
      makeDoc('w2', 'nbi_clearance', 'needs_replacement', '2026-06-01T00:00:00Z'),
    ];
    const result = classifyHiringReview(inputs);
    expect(result.pendingDocs).toBe(0);
    expect(result.deferredDocs).toBe(0);
    expect(result.contractors).toHaveLength(0);
  });

  it('deduplicates to latest by createdAt', () => {
    const inputs = [
      makeDoc('w1', 'resume', 'approved', '2026-06-01T00:00:00Z'),
      makeDoc('w1', 'resume', 'pending', '2026-06-10T00:00:00Z'), // newer → wins
    ];
    const result = classifyHiringReview(inputs);
    // Latest is pending → should appear
    expect(result.pendingDocs).toBe(1);
  });

  it('earlier duplicate does not override latest', () => {
    const inputs = [
      makeDoc('w1', 'resume', 'pending', '2026-06-10T00:00:00Z'), // latest
      makeDoc('w1', 'resume', 'approved', '2026-06-01T00:00:00Z'),
    ];
    const result = classifyHiringReview(inputs);
    expect(result.pendingDocs).toBe(1);
  });

  it('side is part of dedup key — different sides are separate docs', () => {
    const inputs = [
      makeDoc('w1', 'gov_id', 'pending', '2026-06-01T00:00:00Z', 'front'),
      makeDoc('w1', 'gov_id', 'pending', '2026-06-01T00:00:00Z', 'back'),
    ];
    const result = classifyHiringReview(inputs);
    expect(result.pendingDocs).toBe(2);
  });

  it('contractors sorted alphabetically by worker name', () => {
    const inputs = [
      {
        ...makeDoc('wZ', 'resume', 'pending', '2026-06-01T00:00:00Z'),
        workerName: 'Zelda',
      },
      {
        ...makeDoc('wA', 'diploma', 'pending', '2026-06-01T00:00:00Z'),
        workerName: 'Abby',
      },
      {
        ...makeDoc('wM', 'nbi_clearance', 'pending', '2026-06-01T00:00:00Z'),
        workerName: 'Maria',
      },
    ];
    const result = classifyHiringReview(inputs);
    expect(result.contractors.map((c) => c.worker)).toEqual(['Abby', 'Maria', 'Zelda']);
  });

  it('multiple pending docs per worker collected in one entry', () => {
    const inputs = [
      makeDoc('w1', 'resume', 'pending', '2026-06-01T00:00:00Z'),
      makeDoc('w1', 'diploma', 'pending', '2026-06-01T00:00:00Z'),
    ];
    const result = classifyHiringReview(inputs);
    expect(result.pendingContractors).toHaveLength(1);
    expect(result.pendingContractors[0]?.pending).toHaveLength(2);
    expect(result.pendingDocs).toBe(2);
  });

  it('pendingContractors and deferredContractors are correct subsets of contractors', () => {
    const inputs = [
      makeDoc('w1', 'resume', 'pending', '2026-06-01T00:00:00Z'),
      makeDoc('w2', 'diploma', 'deferred', '2026-06-01T00:00:00Z'),
    ];
    const result = classifyHiringReview(inputs);
    expect(result.contractors).toHaveLength(2);
    expect(result.pendingContractors).toHaveLength(1);
    expect(result.deferredContractors).toHaveLength(1);
  });

  it('pendingDocs and deferredDocs counts are correct', () => {
    const inputs = [
      makeDoc('w1', 'resume', 'pending', '2026-06-01T00:00:00Z'),
      makeDoc('w1', 'diploma', 'deferred', '2026-06-01T00:00:00Z'),
      makeDoc('w2', 'nbi_clearance', 'pending', '2026-06-01T00:00:00Z'),
    ];
    const result = classifyHiringReview(inputs);
    expect(result.pendingDocs).toBe(2);
    expect(result.deferredDocs).toBe(1);
  });

  it('worker with only deferred appears only in deferredContractors, not pendingContractors', () => {
    const inputs = [makeDoc('w1', 'diploma', 'deferred', '2026-06-01T00:00:00Z')];
    const result = classifyHiringReview(inputs);
    expect(result.pendingContractors).toHaveLength(0);
    expect(result.deferredContractors).toHaveLength(1);
  });
});
