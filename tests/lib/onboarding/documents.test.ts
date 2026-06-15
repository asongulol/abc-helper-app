import {
  DEFAULT_REQUIRED_DOCS,
  type RequiredDoc,
  type Stage3DocRow,
  type UploadedDocLike,
  deriveDocChecklist,
  isStage3Complete,
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

  it('returns [] for an empty checklist', () => {
    expect(outstandingSlots([])).toEqual([]);
  });
});

describe('deriveDocChecklist — sent-back non-required uploads (legacy parity)', () => {
  const ALL_REQUIRED = [
    upload({ id: 'r1', kind: 'resume', reviewStatus: 'approved' }),
    upload({ id: 'n1', kind: 'nbi_clearance', reviewStatus: 'approved' }),
    upload({ id: 'gf', kind: 'gov_id', side: 'front', reviewStatus: 'approved' }),
    upload({ id: 'gb', kind: 'gov_id', side: 'back', reviewStatus: 'approved' }),
  ];

  it('surfaces a non-required upload (e.g. "other") sent back as needs_replacement', () => {
    const slots = deriveDocChecklist(CFG, [
      ...ALL_REQUIRED,
      upload({ id: 'o1', kind: 'other', reviewStatus: 'needs_replacement' }),
    ]);
    const other = slots.find((s) => s.kind === 'other');
    expect(other?.outstanding).toBe(true);
    expect(other?.documentId).toBe('o1');
    expect(outstandingSlots(slots).map((s) => s.kind)).toEqual(['other']);
  });

  it('surfaces an OPTIONAL configured doc that was uploaded then deferred', () => {
    const slots = deriveDocChecklist(CFG, [
      ...ALL_REQUIRED,
      upload({ id: 'opt', kind: 'optional_thing', reviewStatus: 'deferred' }),
    ]);
    expect(slots.find((s) => s.kind === 'optional_thing')?.outstanding).toBe(true);
  });

  it('does NOT surface a non-required upload that is pending or approved', () => {
    const slots = deriveDocChecklist(CFG, [
      ...ALL_REQUIRED,
      upload({ id: 'w1', kind: 'w8ben', reviewStatus: 'pending' }),
      upload({ id: 'o2', kind: 'other', reviewStatus: 'approved' }),
    ]);
    expect(slots.some((s) => s.kind === 'w8ben' || s.kind === 'other')).toBe(false);
    expect(outstandingSlots(slots)).toEqual([]);
  });
});

describe('deriveDocChecklist — ordering determinism', () => {
  it('picks the same upload regardless of caller order on a createdAt tie', () => {
    const ups = [
      upload({
        id: 'a',
        kind: 'resume',
        reviewStatus: 'approved',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      upload({
        id: 'b',
        kind: 'resume',
        reviewStatus: 'pending',
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ];
    const fwd = deriveDocChecklist(CFG, ups).find((s) => s.kind === 'resume');
    const rev = deriveDocChecklist(CFG, [...ups].reverse()).find((s) => s.kind === 'resume');
    // The id tiebreaker makes the choice total: 'b' > 'a', so 'b' wins for BOTH
    // caller orders — admin (asc) and portal (desc) can never disagree on a tie.
    expect(fwd?.documentId).toBe('b');
    expect(rev?.documentId).toBe('b');
    expect(fwd?.documentId).toBe(rev?.documentId);
    expect(fwd?.state).toBe('pending');
  });

  it('prefers a timestamped upload over one missing createdAt', () => {
    const slots = deriveDocChecklist(CFG, [
      upload({
        id: 'dated',
        kind: 'resume',
        reviewStatus: 'approved',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      upload({ id: 'undated', kind: 'resume', reviewStatus: 'pending' }),
    ]);
    expect(slots.find((s) => s.kind === 'resume')?.documentId).toBe('dated');
  });
});

describe('isStage3Complete', () => {
  const doc = (over: Partial<Stage3DocRow>): Stage3DocRow => ({
    id: 'x',
    kind: 'resume',
    side: null,
    storage_path: '/f',
    review_status: 'approved',
    ...over,
  });
  const ALL: Stage3DocRow[] = [
    doc({ id: 'r', kind: 'resume' }),
    doc({ id: 'd', kind: 'diploma' }),
    doc({ id: 'n', kind: 'nbi_clearance' }),
    doc({ id: 'gf', kind: 'gov_id', side: 'front' }),
    doc({ id: 'gb', kind: 'gov_id', side: 'back' }),
  ];

  it('true when every required kind is approved (both gov_id sides)', () => {
    expect(isStage3Complete(ALL)).toBe(true);
  });

  it('false when a gov_id side is missing', () => {
    expect(isStage3Complete(ALL.filter((d) => d.id !== 'gb'))).toBe(false);
  });

  it('false when a required kind has no row', () => {
    expect(isStage3Complete(ALL.filter((d) => d.kind !== 'diploma'))).toBe(false);
  });

  it('a single waived row clears the whole kind, incl. both gov_id sides', () => {
    const rows: Stage3DocRow[] = [
      doc({ id: 'r', kind: 'resume' }),
      doc({ id: 'd', kind: 'diploma' }),
      doc({ id: 'n', kind: 'nbi_clearance' }),
      doc({ id: 'gw', kind: 'gov_id', side: 'front', storage_path: null, review_status: 'waived' }),
    ];
    // gov_id 'back' was never uploaded, but waiving the kind clears it — this is
    // the rule finishOnboarding previously got wrong.
    expect(isStage3Complete(rows)).toBe(true);
  });

  it('a deferred row clears its kind', () => {
    const rows: Stage3DocRow[] = [
      doc({ id: 'r', kind: 'resume' }),
      doc({ id: 'd', kind: 'diploma', storage_path: null, review_status: 'deferred' }),
      doc({ id: 'n', kind: 'nbi_clearance' }),
      doc({ id: 'gf', kind: 'gov_id', side: 'front' }),
      doc({ id: 'gb', kind: 'gov_id', side: 'back' }),
    ];
    expect(isStage3Complete(rows)).toBe(true);
  });
});
