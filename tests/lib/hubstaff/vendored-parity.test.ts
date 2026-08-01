import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The hubstaff-sync edge function is a vendored Deno copy of the sync (Deno
 * can't import from the Next.js tree) and it writes time_entries over REST —
 * so it never reaches the guard in upsertTimeEntries (src/db/queries/time.ts).
 * The nightly cron is exactly where a departed contractor's days keep arriving,
 * which makes it the copy that matters most and the easiest one to forget.
 *
 * Same shape as tests/lib/wise/vendored-parity.test.ts: assert the vendored
 * rule is present, so deleting or loosening it there fails here.
 */
const deno = readFileSync('supabase/functions/hubstaff-sync/index.ts', 'utf8');

describe('hubstaff-sync edge fn keeps the no-time-after-last-day rule', () => {
  it('selects ended_on on the worker_companies read', () => {
    expect(deno).toContain('ended_on');
    expect(deno).toMatch(/worker_companies\?select=[^`'"]*ended_on/);
  });

  it('drops days after the last day rather than writing them', () => {
    expect(deno).toContain('day > lastDay');
  });

  it('scopes the last day to the company the hours land on', () => {
    expect(deno).toContain('l.company_id === companyId');
  });

  it('reports what it dropped instead of dropping silently', () => {
    expect(deno).toContain('dropped_after_end');
  });
});
