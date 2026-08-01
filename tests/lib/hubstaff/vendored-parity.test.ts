import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { upsertTimeEntries } from '@/db/queries/time';
import type { Database } from '@/db/types';

/**
 * The hubstaff-sync edge function is a vendored Deno copy of the sync (Deno
 * can't import from the Next.js tree) and it writes time_entries over REST —
 * so it never reaches the guard in upsertTimeEntries (src/db/queries/time.ts).
 * The nightly cron is exactly where a departed contractor's days keep arriving,
 * which makes it the copy that matters most and the easiest one to forget.
 *
 * Same shape as tests/lib/wise/vendored-parity.test.ts: the canonical rule is
 * READ FROM LIVE APP CODE rather than restated here, so either side drifting
 * fails. The app half runs upsertTimeEntries for real; the Deno half can only
 * be read as text (importing it needs Deno globals at module scope), with
 * comments stripped so a commented-out guard can't satisfy the match.
 */
const deno = readFileSync('supabase/functions/hubstaff-sync/index.ts', 'utf8')
  // ponytail: naive strip — it also eats `//` inside string literals. None of
  // the four matches below sit in one; a real tokenizer only if that changes.
  .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

/**
 * Does the app keep the last day itself, or drop it? ASKED of the real function
 * instead of asserted, so the vendored expectation below follows the app.
 */
const appKeepsLastDay = async (): Promise<boolean> => {
  type Row = Parameters<typeof upsertTimeEntries>[1][number];
  // The worker_companies read chains .not() then .in() twice before it is awaited.
  const read = Promise.resolve({
    data: [{ company_id: 'co-1', worker_id: 'w1', ended_on: '2026-07-04' }],
    error: null,
  }) as Promise<unknown> & { in: () => unknown; not: () => unknown };
  read.in = () => read;
  read.not = () => read;
  const db = {
    from: () => ({ select: () => read, upsert: () => Promise.resolve({ error: null }) }),
  } as unknown as SupabaseClient<Database>;

  const row = (work_date: string): Row => ({
    company_id: 'co-1',
    worker_id: 'w1',
    source_name: 'Ana Cruz',
    work_date,
    tracked_seconds: 28_800,
    pto_seconds: 0,
    approval: 'pending',
    import_batch_id: 'b1',
    activity_pct: 70,
  });
  // Last day + the day after: exactly 1 dropped ⇒ the last day itself is kept.
  return (await upsertTimeEntries(db, [row('2026-07-04'), row('2026-07-05')])) === 1;
};

describe('hubstaff-sync edge fn keeps the no-time-after-last-day rule', () => {
  it('selects ended_on on the worker_companies read', () => {
    expect(deno).toMatch(/worker_companies\?select=[^`'"]*ended_on/);
  });

  it('drops the same days the app drops', async () => {
    // The app's live boundary decides what the vendored guard must say. Move
    // upsertTimeEntries to `work_date < lastDay` and this demands
    // `day >= lastDay`, which the Deno file does not contain — app-side drift
    // fails here instead of leaving the cron writing days the app would drop.
    expect(deno).toContain((await appKeepsLastDay()) ? 'day > lastDay' : 'day >= lastDay');
  });

  it('scopes the last day to the company the hours land on', () => {
    expect(deno).toContain('l.company_id === companyId');
  });

  it('persists what it dropped instead of only returning it', () => {
    // pg_net throws the HTTP response away, so the count has to reach audit_log
    // — the cron's OWN row. Bounded gaps, or the divergence POST above plus the
    // dropped_after_end in the returned JSON satisfy this with nothing logged.
    expect(deno).toMatch(
      /audit_log[\s\S]{0,300}'Hubstaff cron sync'[\s\S]{0,200}dropped_after_end/,
    );
  });
});
