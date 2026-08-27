import { describe, expect, it } from 'vitest';
import {
  PeriodClosedError,
  type RequireOpenPeriodKey,
  requireOpenPeriod,
} from '@/db/queries/payroll';
import { periodFor } from '@/lib/dates/periods';
import { fakeSupabase, type Tables } from '../../fixtures/supabase-fake';

const COMPANY = 'c-1';
const START = '2026-07-01';
const END = '2026-07-15';

const period = (over: Record<string, unknown> = {}) => ({
  id: 'p-1',
  company_id: COMPANY,
  period_start: START,
  period_end: END,
  // Deliberately NOT the arrears date — proves which paths refresh it.
  pay_date: '2026-01-01',
  state: 'open',
  kind: 'regular',
  include_ha: true,
  include_13: false,
  ...over,
});

const seeded = (rows: Record<string, unknown>[]): Tables => ({ pay_periods: rows });

const byWindow = (over: Record<string, unknown> = {}): RequireOpenPeriodKey =>
  ({ companyId: COMPANY, start: START, end: END, ...over }) as RequireOpenPeriodKey;

describe('requireOpenPeriod — refusals (the one closed-period message)', () => {
  it.each([
    [
      'window, locked',
      [period({ state: 'locked' })],
      byWindow(),
      'Period is locked — unlock first.',
    ],
    ['window, paid', [period({ state: 'paid' })], byWindow(), 'Period is paid — unlock first.'],
    [
      'window, locked — create "missing" never reopens it',
      [period({ state: 'locked' })],
      byWindow({ create: 'missing' }),
      'Period is locked — unlock first.',
    ],
    [
      'window, locked — create "always" never reopens it either',
      [period({ state: 'locked' })],
      byWindow({ create: 'always' }),
      'Period is locked — unlock first.',
    ],
    ['window, missing without create', [], byWindow(), 'Period not found.'],
    [
      'by id, locked',
      [period({ state: 'locked' })],
      { periodId: 'p-1' },
      'Period is locked — unlock first.',
    ],
    ['by id, missing', [], { periodId: 'p-1' }, 'Period not found.'],
    [
      'by id, another company’s period',
      [period()],
      { periodId: 'p-1', companyId: 'c-other' },
      'Period not in this company.',
    ],
  ] as [
    string,
    Record<string, unknown>[],
    RequireOpenPeriodKey,
    string,
  ][])('%s', async (_name, rows, key, message) => {
    const { client, tables } = fakeSupabase(seeded(rows));
    await expect(requireOpenPeriod(client, key, 'unlock first')).rejects.toThrow(message);
    // A refusal never writes — the seed is exactly what remains.
    expect(tables.pay_periods).toHaveLength(rows.length);
  });

  it('throws a typed PeriodClosedError so soft callers (reconcile) can branch on it', async () => {
    const { client } = fakeSupabase(seeded([period({ state: 'paid' })]));
    const err = await requireOpenPeriod(client, byWindow(), 'unlock first').catch((e) => e);
    expect(err).toBeInstanceOf(PeriodClosedError);
    expect((err as PeriodClosedError).state).toBe('paid');
  });
});

describe('requireOpenPeriod — resolution and create', () => {
  it.each([
    ['window, open regular', [period()], byWindow(), 'regular'],
    ['window, open off-cycle batch', [period({ kind: 'off_cycle' })], byWindow(), 'off_cycle'],
    ['by id, open', [period()], { periodId: 'p-1', companyId: COMPANY }, 'regular'],
  ] as [
    string,
    Record<string, unknown>[],
    RequireOpenPeriodKey,
    string,
  ][])('%s → the ref with its window and kind', async (_name, rows, key, kind) => {
    const { client } = fakeSupabase(seeded(rows));
    await expect(requireOpenPeriod(client, key, 'unlock first')).resolves.toEqual({
      id: 'p-1',
      kind,
      periodStart: START,
      periodEnd: END,
    });
  });

  it('create "missing": inserts OPEN with the derived ARREARS pay date and the given flags', async () => {
    const { client, tables } = fakeSupabase(seeded([]));
    const ref = await requireOpenPeriod(
      client,
      byWindow({ create: 'missing', flags: { includeHa: true, includeThirteenth: false } }),
      'unlock first',
    );
    expect(ref.kind).toBe('regular');
    expect(tables.pay_periods?.[0]).toMatchObject({
      company_id: COMPANY,
      period_start: START,
      period_end: END,
      pay_date: periodFor(START).payDate, // derived, never caller input (RP-66)
      state: 'open',
      include_ha: true,
      include_13: false,
    });
  });

  it('create "missing" on an EXISTING open period: touches nothing (reconcile keeps stored flags)', async () => {
    const { client, tables } = fakeSupabase(seeded([period({ include_13: true })]));
    await requireOpenPeriod(
      client,
      byWindow({ create: 'missing', flags: { includeHa: false, includeThirteenth: false } }),
      'unlock first',
    );
    // Divergent seed pay_date and flags survive — no refresh happened.
    expect(tables.pay_periods?.[0]).toMatchObject({ pay_date: '2026-01-01', include_13: true });
  });

  it('create "always" on an EXISTING open period: refreshes the arrears pay date and records the run’s flags (RP-66/RP-20)', async () => {
    const { client, tables } = fakeSupabase(seeded([period({ include_13: false })]));
    await requireOpenPeriod(
      client,
      byWindow({ create: 'always', flags: { includeHa: false, includeThirteenth: true } }),
      'unlock first',
    );
    expect(tables.pay_periods?.[0]).toMatchObject({
      pay_date: periodFor(START).payDate,
      state: 'open',
      include_ha: false,
      include_13: true,
    });
    expect(tables.pay_periods).toHaveLength(1);
  });
});
