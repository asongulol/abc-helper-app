import { describe, expect, it, vi } from 'vitest';

// TimeShell pulls in the time server actions (Supabase client + env validation)
// at module load. The helpers under test are pure, so placeholders suffice.
vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key-0000000000000000');
vi.stubEnv('SUPABASE_SERVICE_KEY', 'test-service-key-0000000000000000');

const { reviewStatus, timeHref } = await import('@/components/time/TimeShell');

describe('reviewStatus — "nothing imported" is not "all approved" (RP-42)', () => {
  it('reports empty when the period has no entries at all', () => {
    // The misleading case: "all clear" before a sync has ever run.
    expect(reviewStatus(0, 0)).toBe('empty');
  });

  it('reports pending while any entry is undecided', () => {
    expect(reviewStatus(12, 3)).toBe('pending');
  });

  it('reports clear only when entries exist and none are pending', () => {
    expect(reviewStatus(12, 0)).toBe('clear');
  });
});

describe('timeHref — the period survives the unpaid toggle (RP-51)', () => {
  const period = { start: '2026-07-01', end: '2026-07-15', payDate: '2026-07-20' };

  it('keeps ?start/?end when entering all-unpaid mode', () => {
    expect(timeHref('/time', period, true)).toBe('/time?start=2026-07-01&end=2026-07-15&unpaid=1');
  });

  it('keeps the picked period when leaving all-unpaid mode', () => {
    // The bug: router.push(pathname) dropped ?start and dumped you on the default period.
    expect(timeHref('/time', period, false)).toBe('/time?start=2026-07-01&end=2026-07-15');
  });
});
