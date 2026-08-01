import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  type AuditLogRow,
  getPayfileDownloads,
  lastPayfileDownloads,
  PAYFILE_DOWNLOAD_ACTION,
} from '@/db/queries/audit';
import type { Database } from '@/db/types';

const row = (p: Partial<AuditLogRow> & { createdAt: string }): AuditLogRow => ({
  id: p.createdAt,
  actor: null,
  action: PAYFILE_DOWNLOAD_ACTION,
  entity: 'period-1',
  companyId: 'co-1',
  detail: { kind: 'wise' },
  ...p,
});

describe('lastPayfileDownloads — cross-admin double-export guard (RP-59)', () => {
  it('keeps only the newest record per file kind, whatever the input order', () => {
    const out = lastPayfileDownloads(
      [
        row({ createdAt: '2026-07-20T09:00:00Z', actor: 'a@x.com' }),
        row({ createdAt: '2026-07-28T09:00:00Z', actor: 'b@x.com' }),
        row({ createdAt: '2026-07-25T09:00:00Z', actor: 'c@x.com' }),
        row({
          createdAt: '2026-07-26T09:00:00Z',
          actor: 'd@x.com',
          detail: { kind: 'individual' },
        }),
      ],
      'me@x.com',
    );
    expect(out).toEqual([
      { kind: 'wise', at: '2026-07-28T09:00:00Z', actor: 'b@x.com', byOther: true },
      { kind: 'individual', at: '2026-07-26T09:00:00Z', actor: 'd@x.com', byOther: true },
    ]);
  });

  it('flags another admin — the case the localStorage stamp cannot see', () => {
    const rows = [row({ createdAt: '2026-07-28T09:00:00Z', actor: 'other@x.com' })];
    expect(lastPayfileDownloads(rows, 'me@x.com')[0]?.byOther).toBe(true);
  });

  it('does not flag my own earlier download from another machine', () => {
    const rows = [row({ createdAt: '2026-07-28T09:00:00Z', actor: 'me@x.com' })];
    expect(lastPayfileDownloads(rows, 'me@x.com')[0]?.byOther).toBe(false);
  });

  it('treats an unknown actor as someone else — "not provably me" must warn', () => {
    const rows = [row({ createdAt: '2026-07-28T09:00:00Z', actor: null })];
    expect(lastPayfileDownloads(rows, 'me@x.com')[0]?.byOther).toBe(true);
  });

  it('ignores other audit actions and records with no file kind', () => {
    expect(
      lastPayfileDownloads(
        [
          row({ createdAt: '2026-07-28T09:00:00Z', action: 'batch_locked' }),
          row({ createdAt: '2026-07-27T09:00:00Z', detail: null }),
          row({ createdAt: '2026-07-26T09:00:00Z', detail: { rows: 3 } }),
          row({ createdAt: '2026-07-25T09:00:00Z', detail: ['wise'] }),
        ],
        'me@x.com',
      ),
    ).toEqual([]);
  });

  it('returns nothing when the period was never exported', () => {
    expect(lastPayfileDownloads([], 'me@x.com')).toEqual([]);
  });
});

/** Records the filters the read applies, so a dropped one fails the test.
 *  A real Promise underneath, like the awaitable Supabase builder. */
type Chain = Promise<{ data: unknown[]; error: null }> & Record<string, unknown>;

const stubDb = () => {
  const filters: Record<string, unknown> = {};
  const chain = Promise.resolve({ data: [], error: null }) as unknown as Chain;
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => {
    filters[col] = val;
    return chain;
  };
  chain.order = () => chain;
  chain.limit = () => chain;
  return { db: { from: () => chain } as unknown as SupabaseClient<Database>, filters };
};

describe('getPayfileDownloads — the double-pay guard only holds if it reads the right rows', () => {
  // #94. Both filters are load-bearing and neither is re-checked after the read:
  // without `entity` another period's export warns on this one, and without
  // `action` the 20-row window fills with unrelated audit rows that
  // lastPayfileDownloads then discards — no warning at all, which is the
  // direction that lets a second admin export and pay the same batch twice.
  it('reads payfile downloads for this period only', async () => {
    const { db, filters } = stubDb();
    await getPayfileDownloads(db, 'period-1', 'me@x.com');

    expect(filters).toEqual({ action: PAYFILE_DOWNLOAD_ACTION, entity: 'period-1' });
  });
});
