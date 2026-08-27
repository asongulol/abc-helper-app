import { describe, expect, it } from 'vitest';
import {
  type MatchRecipient,
  type MatchWorker,
  otherHolderName,
  planRecipientMatches,
} from '@/lib/wise/recipient-match';

const rec = (id: number, name: string): MatchRecipient => ({
  id,
  name,
  currency: 'PHP',
  account: '••••0000',
});
const wk = (over: Partial<MatchWorker>): MatchWorker => ({
  id: `w-${over.name ?? '?'}`,
  name: 'X',
  status: 'active',
  wiseRecipientId: null,
  ...over,
});

describe('planRecipientMatches', () => {
  it('marks a recipient already-linked when ANY contractor (even ended) holds its id', () => {
    // The regression: an ended contractor that holds the id is still linked.
    const rows = planRecipientMatches(
      [rec(1361399245, 'Justina Mae Evardo La Losa')],
      [wk({ name: 'Justina Mae Evardo La Losa', status: 'ended', wiseRecipientId: 1361399245 })],
    );
    expect(rows[0]?.status).toBe('already-linked');
    expect(rows[0]?.contractor?.name).toBe('Justina Mae Evardo La Losa');
  });

  it('name-matches an ACTIVE unlinked contractor and exposes it for writing', () => {
    const rows = planRecipientMatches(
      [rec(900, 'Maria Dela Cruz')],
      [wk({ id: 'w1', name: 'Maria Dela Cruz', status: 'active', wiseRecipientId: null })],
    );
    expect(rows[0]?.status).toBe('matched');
    expect(rows[0]?.contractor?.id).toBe('w1');
  });

  it('does NOT name-match an ended contractor (only active unlinked are writeable)', () => {
    const rows = planRecipientMatches(
      [rec(900, 'Maria Dela Cruz')],
      [wk({ name: 'Maria Dela Cruz', status: 'ended', wiseRecipientId: null })],
    );
    expect(rows[0]?.status).toBe('unmatched');
  });

  it('leaves a company recipient with no contractor as unmatched', () => {
    const rows = planRecipientMatches(
      [rec(1156408210, 'Ability Builders for Children, LLC')],
      [wk({ name: 'Maria Dela Cruz', status: 'active', wiseRecipientId: null })],
    );
    expect(rows[0]?.status).toBe('unmatched');
    expect(rows[0]?.contractor).toBeNull();
  });

  it('sorts already-linked/matched before unmatched', () => {
    const rows = planRecipientMatches(
      [rec(1, 'Zeta Co. LLC'), rec(2, 'Linked Person')],
      [wk({ name: 'Linked Person', wiseRecipientId: 2 })],
    );
    expect(rows.map((r) => r.status)).toEqual(['already-linked', 'unmatched']);
  });
});

// RP-55: one Wise recipient = one bank account = one contractor.
describe('otherHolderName', () => {
  const holder = (id: string, first: string, last: string) => ({
    id,
    first_name: first,
    last_name: last,
  });

  it('returns null when nobody holds the identifier', () => {
    expect(otherHolderName([], 'w1')).toBeNull();
  });

  it('returns null when only this worker holds it (re-saving stays idempotent)', () => {
    expect(otherHolderName([holder('w1', 'Maria', 'Dela Cruz')], 'w1')).toBeNull();
  });

  it('names the other contractor holding it', () => {
    expect(otherHolderName([holder('w2', 'Juan', 'Santos')], 'w1')).toBe('Juan Santos');
  });

  it('finds the other holder even when this worker is in the list too', () => {
    expect(
      otherHolderName([holder('w1', 'Maria', 'Dela Cruz'), holder('w2', 'Juan', 'Santos')], 'w1'),
    ).toBe('Juan Santos');
  });

  it('falls back to a generic label when the other row has no name', () => {
    expect(otherHolderName([holder('w2', '', '')], 'w1')).toBe('another contractor');
  });
});
