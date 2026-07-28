import { describe, expect, it, vi } from 'vitest';

// TimeApprovalTable pulls in the time server actions (Supabase client + env
// validation) at module load. reviewRows is pure, so placeholders suffice.
vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key-0000000000000000');
vi.stubEnv('SUPABASE_SERVICE_KEY', 'test-service-key-0000000000000000');

const { reviewRows } = await import('@/components/time/TimeApprovalTable');

const row = (sourceName: string, approvalStatus: string) => ({ sourceName, approvalStatus });

describe('reviewRows — the grid order/filter at 100+ contractors (RP-43)', () => {
  it('puts still-blocking rows above decided ones', () => {
    const rows = [row('Zoe', 'pending'), row('Ana', 'approved'), row('Mia', 'pending')];
    expect(reviewRows(rows, false).map((r) => r.sourceName)).toEqual(['Mia', 'Zoe', 'Ana']);
  });

  it('treats a partly-decided (mixed) row as still blocking', () => {
    const rows = [row('Ana', 'approved'), row('Zoe', 'mixed')];
    expect(reviewRows(rows, false).map((r) => r.sourceName)).toEqual(['Zoe', 'Ana']);
  });

  it('keeps alphabetical order within each group', () => {
    const rows = [row('Bo', 'approved'), row('Al', 'approved'), row('Cy', 'pending')];
    expect(reviewRows(rows, false).map((r) => r.sourceName)).toEqual(['Cy', 'Al', 'Bo']);
  });

  it('drops decided rows when "only pending" is on', () => {
    const rows = [row('Zoe', 'pending'), row('Ana', 'approved'), row('Rex', 'rejected')];
    expect(reviewRows(rows, true).map((r) => r.sourceName)).toEqual(['Zoe']);
  });

  it('never mutates the caller’s array', () => {
    const rows = [row('Zoe', 'pending'), row('Ana', 'approved')];
    reviewRows(rows, false);
    expect(rows.map((r) => r.sourceName)).toEqual(['Zoe', 'Ana']);
  });
});
