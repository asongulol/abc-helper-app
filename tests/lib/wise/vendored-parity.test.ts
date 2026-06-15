import { readFileSync } from 'node:fs';
import { WISE_IN_FLIGHT_STATES, WISE_PAID_STATES } from '@/lib/wise/types';
import { describe, expect, it } from 'vitest';

/**
 * The wise-payouts edge function vendors WISE_PAID_STATES / WISE_IN_FLIGHT_STATES
 * and the date-precedence helpers from src/lib/wise (Deno can't import from the
 * Next.js tree). This guards against the vendored copy silently drifting — if a
 * canonical state is added or removed, this test flags the Deno copy.
 */
const deno = readFileSync('supabase/functions/wise-payouts/index.ts', 'utf8');

describe('wise-payouts edge fn vendored constants stay in sync with src/lib/wise', () => {
  it('vendors every canonical paid state', () => {
    for (const s of WISE_PAID_STATES) expect(deno).toContain(`'${s}'`);
  });

  it('vendors every canonical in-flight state', () => {
    for (const s of WISE_IN_FLIGHT_STATES) expect(deno).toContain(`'${s}'`);
  });

  it('keeps the dateSent > dateFunded > created precedence (bestSentDate)', () => {
    expect(deno).toContain('dates.dateSent ?? dates.dateFunded ?? dates.created');
  });
});
