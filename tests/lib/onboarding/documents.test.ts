import {
  DEFAULT_REQUIRED_DOCS,
  type RequiredDoc,
  type UploadedDocLike,
  deriveDocChecklist,
  outstandingSlots,
} from '@/lib/onboarding/documents';
import { describe, expect, it } from 'vitest';

const CFG: RequiredDoc[] = [
  { kind: 'resume', title: 'Resume / CV', required: true },
  { kind: 'nbi_clearance', title: 'NBI Clearance', required: true, freshness_months: 6 },
  { kind: 'gov_id', title: 'Government-issued ID', required: true, sides: ['front', 'back'] },
  { kind: 'optional_thing', title: 'Optional thing', required: false },
];

const upload = (over: Partial<UploadedDocLike>): UploadedDocLike => ({
  id: 'd1',
  kind: 'resume',
  side: null,
  reviewStatus: 'pending',
  ...over,
});

describe('deriveDocChecklist', () => {
  it('lists every required slot as missing when nothing is uploaded', () => {
    const slots = deriveDocChecklist(CFG, []);
    // resume + nbi + gov_id(front) + gov_id(back) = 4; optional excluded
    expect(slots).toHaveLength(4);
    expect(slots.every((s) => s.state === 'missing')).toBe(true);
    expect(slots.every((s) => s.outstanding && !s.uploaded)).toBe(true);
    expect(slots.map((s) => s.label)).toEqual([
      'Resume / CV',
      'NBI Clearance',
      'Government-issued ID (front)',
      'Government-issued ID (back)',
    ]);
  });

  it('excludes documents marked required:false', () => {
    const slots = deriveDocChecklist(CFG, []);
    expect(slots.some((s) => s.kind === 'optional_thing')).toBe(false);
  });

  it('expands two-sided docs into one slot per side', () => {
    const slots = deriveDocChecklist(CFG, []).filter((s) => s.kind === 'gov_id');
    expect(slots.map((s) => s.side)).toEqual(['front', 'back']);
  });

  it('falls back to DEFAULT_REQUIRED_DOCS when config has no documents', () => {
    const slots = deriveDocChecklist([], []);
    const kinds = new Set(slots.map((s) => s.kind));
    for (const d of DEFAULT_REQUIRED_DOCS) expect(kinds.has(d.kind)).toBe(true);
  });

  it('marks an uploaded-but-pending doc as not outstanding (awaiting admin)', () => {
    const slots = deriveDocChecklist(CFG, [
      upload({ id: 'r1', kind: 'resume', reviewStatus: 'pending' }),
    ]);
    const resume = slots.find((s) => s.kind === 'resume');
    expect(resume?.state).toBe('pending');
    expect(resume?.uploaded).toBe(true);
    expect(resume?.outstanding).toBe(false);
    expect(resume?.documentId).toBe('r1');
  });

  it('keeps needs_replacement and (still) missing docs outstanding', () => {
    const slots = deriveDocChecklist(CFG, [
      upload({ id: 'r1', kind: 'resume', reviewStatus: 'needs_replacement' }),
    ]);
    expect(slots.find((s) => s.kind === 'resume')?.outstanding).toBe(true);
    expect(slots.find((s) => s.kind === 'nbi_clearance')?.outstanding).toBe(true);
  });

  it('treats approved/waived as resolved (not outstanding)', () => {
    const slots = deriveDocChecklist(CFG, [
      upload({ id: 'r1', kind: 'resume', reviewStatus: 'approved' }),
      upload({ id: 'n1', kind: 'nbi_clearance', reviewStatus: 'waived' }),
    ]);
    expect(slots.find((s) => s.kind === 'resume')?.outstanding).toBe(false);
    expect(slots.find((s) => s.kind === 'nbi_clearance')?.outstanding).toBe(false);
  });

  it('matches each side of a two-sided doc independently', () => {
    const slots = deriveDocChecklist(CFG, [
      upload({ id: 'f1', kind: 'gov_id', side: 'front', reviewStatus: 'approved' }),
    ]);
    const front = slots.find((s) => s.kind === 'gov_id' && s.side === 'front');
    const back = slots.find((s) => s.kind === 'gov_id' && s.side === 'back');
    expect(front?.state).toBe('approved');
    expect(back?.state).toBe('missing');
  });

  it('picks the latest upload per slot by createdAt', () => {
    const slots = deriveDocChecklist(CFG, [
      upload({
        id: 'old',
        kind: 'resume',
        reviewStatus: 'needs_replacement',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      upload({
        id: 'new',
        kind: 'resume',
        reviewStatus: 'approved',
        createdAt: '2026-02-01T00:00:00Z',
      }),
    ]);
    const resume = slots.find((s) => s.kind === 'resume');
    expect(resume?.documentId).toBe('new');
    expect(resume?.state).toBe('approved');
  });
});

describe('outstandingSlots', () => {
  it('returns only the slots the contractor still owes', () => {
    const slots = deriveDocChecklist(CFG, [
      upload({ id: 'r1', kind: 'resume', reviewStatus: 'approved' }),
    ]);
    const owed = outstandingSlots(slots);
    expect(owed.some((s) => s.kind === 'resume')).toBe(false);
    expect(owed.map((s) => `${s.kind}|${s.side ?? ''}`)).toEqual([
      'nbi_clearance|',
      'gov_id|front',
      'gov_id|back',
    ]);
  });
});
