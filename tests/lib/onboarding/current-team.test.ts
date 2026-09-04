/**
 * Current team open items (docs/CONTRACT-VERSIONS-PLAN.md §7.4): one row per
 * contractor, one item per thing still owed, judged on the latest upload per slot.
 */

import { describe, expect, it } from 'vitest';
import { deriveOpenItems, type TeamDoc } from '@/lib/onboarding/current-team';

const TODAY = '2026-09-04';

const doc = (over: Partial<TeamDoc> & { id: string }): TeamDoc => ({
  kind: 'nbi_clearance',
  side: null,
  reviewStatus: 'approved',
  storagePath: `docs/${over.id}.pdf`,
  expiresOn: null,
  deferUntil: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

const kinds = (items: ReturnType<typeof deriveOpenItems>) => items.map((i) => i.kind);

describe('deriveOpenItems — contract', () => {
  it('an in-flight version is the item; no version and no v1 signature is "no agreement"', () => {
    expect(
      kinds(
        deriveOpenItems(
          {
            version: { status: 'sent', sentAt: '2026-09-01T10:00:00Z' },
            hasIcSignature: true,
            docs: [],
          },
          TODAY,
        ),
      ),
    ).toEqual(['sent']);
    expect(
      deriveOpenItems(
        {
          version: { status: 'sent', sentAt: '2026-09-01T10:00:00Z' },
          hasIcSignature: true,
          docs: [],
        },
        TODAY,
      )[0]?.label,
    ).toBe('Contract sent · 3 days');
    expect(
      kinds(
        deriveOpenItems(
          { version: { status: 'signed', sentAt: null }, hasIcSignature: true, docs: [] },
          TODAY,
        ),
      ),
    ).toEqual(['signed']);
    expect(
      kinds(
        deriveOpenItems(
          { version: { status: 'draft', sentAt: null }, hasIcSignature: false, docs: [] },
          TODAY,
        ),
      ),
    ).toEqual(['draft']);
    expect(
      kinds(deriveOpenItems({ version: null, hasIcSignature: false, docs: [] }, TODAY)),
    ).toEqual(['no_agreement']);
  });

  it('an active version or a v1 signature means nothing is owed', () => {
    expect(
      deriveOpenItems(
        { version: { status: 'active', sentAt: null }, hasIcSignature: false, docs: [] },
        TODAY,
      ),
    ).toEqual([]);
    expect(deriveOpenItems({ version: null, hasIcSignature: true, docs: [] }, TODAY)).toEqual([]);
  });
});

describe('deriveOpenItems — documents', () => {
  const base = { version: null, hasIcSignature: true };

  it('judges review state on the latest upload per slot', () => {
    const docs = [
      doc({ id: 'a', reviewStatus: 'needs_replacement', createdAt: '2026-08-01T00:00:00Z' }),
      doc({ id: 'b', reviewStatus: 'pending', createdAt: '2026-08-02T00:00:00Z' }),
    ];
    expect(kinds(deriveOpenItems({ ...base, docs }, TODAY))).toEqual(['doc_review']);
    expect(kinds(deriveOpenItems({ ...base, docs: [docs[0] as TeamDoc] }, TODAY))).toEqual([
      'doc_replacement',
    ]);
  });

  it('a deferred doc counts only once its date has come', () => {
    const due = doc({
      id: 'd',
      reviewStatus: 'deferred',
      storagePath: null,
      deferUntil: '2026-09-04',
    });
    const later = doc({
      id: 'l',
      reviewStatus: 'deferred',
      storagePath: null,
      deferUntil: '2026-10-01',
    });
    const undated = doc({ id: 'u', reviewStatus: 'deferred', storagePath: null, deferUntil: null });
    expect(kinds(deriveOpenItems({ ...base, docs: [due] }, TODAY))).toEqual(['doc_deferred']);
    expect(deriveOpenItems({ ...base, docs: [later] }, TODAY)).toEqual([]);
    expect(kinds(deriveOpenItems({ ...base, docs: [undated] }, TODAY))).toEqual(['doc_deferred']);
  });

  it('expiry: expired < today ≤ expiring within 30 days; fileless rows never expire', () => {
    const expired = doc({ id: 'x', expiresOn: '2026-09-03' });
    const soon = doc({ id: 's', kind: 'gov_id', side: 'front', expiresOn: '2026-09-20' });
    const far = doc({ id: 'f', kind: 'gov_id', side: 'back', expiresOn: '2026-12-01' });
    const fileless = doc({ id: 'p', kind: 'resume', expiresOn: '2026-09-01', storagePath: null });
    const items = deriveOpenItems({ ...base, docs: [expired, soon, far, fileless] }, TODAY);
    expect(kinds(items)).toEqual(['doc_expired', 'doc_expiring']);
    expect(items[1]?.label).toBe('Document expires in 16 days');
  });
});
