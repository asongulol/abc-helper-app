import { describe, expect, it } from 'vitest';
import {
  type AuditLogRow,
  lastPayfileDownloads,
  PAYFILE_DOWNLOAD_ACTION,
} from '@/db/queries/audit';

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
