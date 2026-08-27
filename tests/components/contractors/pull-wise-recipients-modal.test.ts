import { describe, expect, it, vi } from 'vitest';
import type { PullRecipientRow } from '@/lib/wise/recipient-match';

// The modal imports the Wise server actions, which pull in the Supabase client
// and its env validation at module load. The helper under test is pure, so
// placeholder credentials are enough to get the module imported.
vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key-0000000000000000');
vi.stubEnv('SUPABASE_SERVICE_KEY', 'test-service-key-0000000000000000');

const { linkableRecipientIds } = await import('@/components/contractors/PullWiseRecipientsModal');

const row = (p: Partial<PullRecipientRow> & { recipientId: number }): PullRecipientRow => ({
  name: `Recipient ${p.recipientId}`,
  currency: 'PHP',
  account: '****1234',
  contractor: { id: `w-${p.recipientId}`, name: 'Jane Dela Cruz' },
  status: 'matched',
  ...p,
});

describe('linkableRecipientIds — what the confirm step submits (RP-56)', () => {
  it('offers only name-match proposals', () => {
    expect(
      linkableRecipientIds([
        row({ recipientId: 1, status: 'already-linked' }),
        row({ recipientId: 2 }),
        row({ recipientId: 3, status: 'unmatched', contractor: null }),
      ]),
    ).toEqual([2]);
  });

  it('drops rows this call already wrote, so a second confirm cannot re-link them', () => {
    expect(
      linkableRecipientIds([row({ recipientId: 7, linked: true }), row({ recipientId: 8 })]),
    ).toEqual([8]);
  });

  it('never offers a proposal with no contractor to link to', () => {
    expect(linkableRecipientIds([row({ recipientId: 9, contractor: null })])).toEqual([]);
  });

  it('is empty on a preview with nothing to confirm', () => {
    expect(linkableRecipientIds([])).toEqual([]);
  });
});
