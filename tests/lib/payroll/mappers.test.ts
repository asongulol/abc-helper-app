import { describe, expect, it } from 'vitest';
import {
  attributeTimeEntries,
  buildStatements,
  centavosToPhp,
  phpToCentavos,
  type RosterRow,
  type TimeEntryRow,
  toPaymentDraft,
} from '@/lib/payroll/mappers';

const roster = (over: Partial<RosterRow> & { workerId: string }): RosterRow => ({
  contract: 'FT',
  payBasis: null,
  hubstaffName: null,
  linkStatus: 'active',
  worker: {
    firstName: 'Ana',
    middleName: null,
    lastName: 'Reyes',
    hireDate: null,
    status: 'active',
    payoutMethod: 'wise',
    healthAllowanceEligible: false,
    thirteenthMonthEligible: false,
  },
  ...over,
});

const entry = (over: Partial<TimeEntryRow>): TimeEntryRow => ({
  workerId: null,
  sourceName: null,
  workDate: '2026-06-01',
  trackedSeconds: 0,
  ptoSeconds: 0,
  ...over,
});

describe('attributeTimeEntries (legacy widByName resolution)', () => {
  it('resolves direct worker_id rows and aggregates tracked + PTO seconds', () => {
    const res = attributeTimeEntries(
      [
        entry({ workerId: 'w1', trackedSeconds: 3600 }),
        entry({
          workerId: 'w1',
          workDate: '2026-06-02',
          trackedSeconds: 1800,
          ptoSeconds: 1800,
        }),
      ],
      [roster({ workerId: 'w1' })],
    );
    expect(res.secondsByWorker.get('w1')).toBe(7200);
    expect(res.daysByWorker.get('w1')?.size).toBe(2);
    expect(res.unattributed).toEqual([]);
  });

  it('resolves null worker_id by hubstaff name and by normalized full name', () => {
    const links = [
      roster({ workerId: 'w1', hubstaffName: 'Ana R.' }),
      roster({
        workerId: 'w2',
        worker: {
          ...roster({ workerId: 'w2' }).worker,
          firstName: 'José',
          lastName: 'Rizal',
        },
      }),
    ];
    const res = attributeTimeEntries(
      [
        entry({ sourceName: 'Ana R.', trackedSeconds: 100 }),
        entry({ sourceName: 'rizal jose', trackedSeconds: 200 }), // order-insensitive key
      ],
      links,
    );
    expect(res.secondsByWorker.get('w1')).toBe(100);
    expect(res.secondsByWorker.get('w2')).toBe(200);
  });

  it('resolves via the loose first+last fallback (unified with the import-time matcher)', () => {
    // Roster worker is "Ana Reyes" (no middle); the source name carries an extra
    // middle. The old calc-time matcher was strict-only and dropped this to
    // `unattributed` — now it matches loosely, exactly like import-time.
    const res = attributeTimeEntries(
      [entry({ sourceName: 'Ana Marie Reyes', trackedSeconds: 300 })],
      [roster({ workerId: 'w1' })],
    );
    expect(res.secondsByWorker.get('w1')).toBe(300);
    expect(res.unattributed).toEqual([]);
  });

  it('surfaces unattributed names and unlinked workers — never drops silently', () => {
    const res = attributeTimeEntries(
      [
        entry({ sourceName: 'Unknown Person', trackedSeconds: 100 }),
        entry({ workerId: 'w9', trackedSeconds: 100 }),
      ],
      [roster({ workerId: 'w1' })],
    );
    expect(res.unattributed).toEqual(['Unknown Person']);
    expect(res.unlinkedWorkerIds).toEqual(['w9']);
    expect(res.secondsByWorker.size).toBe(0);
  });
});

describe('buildStatements + toPaymentDraft', () => {
  const rates = [
    {
      workerId: 'w1',
      amountPhp: '15000.00',
      effectiveStart: '2026-01-01',
      effectiveEnd: null,
    },
  ];

  it('builds an engine row and maps it to a payments draft (PHP major units)', () => {
    const attribution = attributeTimeEntries(
      [entry({ workerId: 'w1', trackedSeconds: 88 * 3600 })],
      [roster({ workerId: 'w1' })],
    );
    const rows = buildStatements({
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
      attribution,
      roster: [roster({ workerId: 'w1' })],
      rates,
    });
    expect(rows).toHaveLength(1);
    const draft = toPaymentDraft(rows[0] as NonNullable<(typeof rows)[0]>, {
      fxRate: 58,
    });
    expect(draft).toMatchObject({
      worker_id: 'w1',
      expected_hours: 88,
      worked_hours: 88,
      performance_ratio: 1,
      rate_php: 15000,
      gross_php: 15000,
      net_php: 15000,
      payout_amount: 15000,
      payout_currency: 'PHP',
      payout_method: 'wise',
      status: 'draft',
      fx_rate: 58,
    });
  });

  it('skips persistence for workers without a rate (net null)', () => {
    const attribution = attributeTimeEntries(
      [entry({ workerId: 'w2', trackedSeconds: 40 * 3600 })],
      [roster({ workerId: 'w2' })],
    );
    const rows = buildStatements({
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
      attribution,
      roster: [roster({ workerId: 'w2' })],
      rates, // only w1 has a rate
    });
    expect(rows[0]?.result.net).toBeNull();
    expect(toPaymentDraft(rows[0] as NonNullable<(typeof rows)[0]>, { fxRate: 58 })).toBeNull();
  });

  it('marks inactive links for the lock-time warning and falls back to last payout method', () => {
    const inactiveLink = roster({
      workerId: 'w1',
      linkStatus: 'inactive',
      worker: { ...roster({ workerId: 'w1' }).worker, payoutMethod: null },
    });
    const attribution = attributeTimeEntries(
      [entry({ workerId: 'w1', trackedSeconds: 10 * 3600 })],
      [inactiveLink],
    );
    const rows = buildStatements({
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
      attribution,
      roster: [inactiveLink],
      rates,
      lastPayoutMethod: new Map([['w1', 'gcash']]),
    });
    expect(rows[0]?.inactive).toBe(true);
    expect(rows[0]?.payoutMethod).toBe('gcash');
  });

  it('stores legacy rounding: worked 2 dp, ratio 4 dp; prorated gross to the centavo', () => {
    const attribution = attributeTimeEntries(
      [entry({ workerId: 'w1', trackedSeconds: Math.round(61.7777 * 3600) })],
      [roster({ workerId: 'w1' })],
    );
    const rows = buildStatements({
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
      attribution,
      roster: [roster({ workerId: 'w1' })],
      rates,
    });
    const draft = toPaymentDraft(rows[0] as NonNullable<(typeof rows)[0]>, {
      fxRate: undefined,
    });
    expect(draft?.worked_hours).toBe(61.78);
    expect(draft?.performance_ratio).toBe(0.702);
    expect(draft?.gross_php).toBeCloseTo(10530.3, 2); // round(61.77778/88 × 15000)
    expect(draft?.fx_rate).toBeNull();
  });
});

describe('F4: date-aware PH/PS gross on a mid-period rate change', () => {
  const phWorker = (workerId: string): RosterRow => roster({ workerId, contract: 'PH' });

  it('PH: prices pre-change hours at the old rate and post-change hours at the new rate', () => {
    // ₱200/hr through 06-08, ₱250/hr from 06-09 (exclusive close, no overlap).
    const rates = [
      {
        workerId: 'w1',
        amountPhp: '200.00',
        effectiveStart: '2026-06-01',
        effectiveEnd: '2026-06-08',
      },
      {
        workerId: 'w1',
        amountPhp: '250.00',
        effectiveStart: '2026-06-09',
        effectiveEnd: null,
      },
    ];
    const attribution = attributeTimeEntries(
      [
        entry({ workerId: 'w1', workDate: '2026-06-05', trackedSeconds: 10 * 3600 }),
        entry({ workerId: 'w1', workDate: '2026-06-10', trackedSeconds: 10 * 3600 }),
      ],
      [phWorker('w1')],
    );
    const rows = buildStatements({
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
      attribution,
      roster: [phWorker('w1')],
      rates,
    });
    // Date-aware: 200×10 + 250×10 = 4500, NOT the naive latest-rate 250×20 = 5000.
    expect(rows[0]?.result.gross).toBe(450_000);
    const draft = toPaymentDraft(rows[0] as NonNullable<(typeof rows)[0]>, { fxRate: undefined });
    expect(draft?.gross_php).toBe(4500);
  });

  it('PH: single rate across the period is unchanged (naive product, parity)', () => {
    const rates = [
      { workerId: 'w1', amountPhp: '250.00', effectiveStart: '2026-01-01', effectiveEnd: null },
    ];
    const attribution = attributeTimeEntries(
      [
        entry({ workerId: 'w1', workDate: '2026-06-05', trackedSeconds: 10 * 3600 }),
        entry({ workerId: 'w1', workDate: '2026-06-10', trackedSeconds: 10 * 3600 }),
      ],
      [phWorker('w1')],
    );
    const rows = buildStatements({
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
      attribution,
      roster: [phWorker('w1')],
      rates,
    });
    expect(rows[0]?.result.gross).toBe(500_000); // 250 × 20h
  });

  it('PS: prices pre-change sessions at the old rate and post-change at the new rate', () => {
    const rates = [
      {
        workerId: 'w1',
        amountPhp: '300.00',
        effectiveStart: '2026-06-01',
        effectiveEnd: '2026-06-08',
      },
      {
        workerId: 'w1',
        amountPhp: '400.00',
        effectiveStart: '2026-06-09',
        effectiveEnd: null,
      },
    ];
    const ps = roster({ workerId: 'w1', contract: 'PS' });
    const attribution = attributeTimeEntries([], [ps]);
    const rows = buildStatements({
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
      attribution,
      roster: [ps],
      rates,
      sessionsByWorker: new Map([['w1', 5]]),
      sessionUnitsByWorkerByDate: new Map([
        [
          'w1',
          new Map([
            ['2026-06-05', 2],
            ['2026-06-10', 3],
          ]),
        ],
      ]),
    });
    // 300×2 + 400×3 = 1800, NOT latest 400×5 = 2000.
    expect(rows[0]?.result.gross).toBe(180_000);
  });

  it('PHS + per_session worker with sessions but no tracked time is pulled in and paid', () => {
    const rates = [
      { workerId: 'w1', amountPhp: '400.00', effectiveStart: '2026-06-01', effectiveEnd: null },
    ];
    const phs = roster({ workerId: 'w1', contract: 'PHS', payBasis: 'per_session' });
    const attribution = attributeTimeEntries([], [phs]);
    const rows = buildStatements({
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
      attribution,
      roster: [phs],
      rates,
      sessionsByWorker: new Map([['w1', 5]]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result.gross).toBe(200_000); // 5 × ₱400
    expect(rows[0]?.payBasis).toBe('per_session');
  });

  it('PHS with an unset pay_basis is never silently paid (gross null, unpersistable)', () => {
    const rates = [
      { workerId: 'w1', amountPhp: '400.00', effectiveStart: '2026-06-01', effectiveEnd: null },
    ];
    const phs = roster({ workerId: 'w1', contract: 'PHS', payBasis: null });
    const attribution = attributeTimeEntries(
      [entry({ workerId: 'w1', trackedSeconds: 40 * 3600, workDate: '2026-06-05' })],
      [phs],
    );
    const rows = buildStatements({
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
      attribution,
      roster: [phs],
      rates,
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.result.gross).toBeNull();
    expect(row?.result.payBasisUnset).toBe(true);
    if (row) expect(toPaymentDraft(row, {})).toBeNull(); // not persistable
  });
});

describe('F7: HA-eligible worker with zero approved time in their anniversary period', () => {
  const haRates = [
    { workerId: 'w1', amountPhp: '15000.00', effectiveStart: '2024-01-01', effectiveEnd: null },
  ];
  const haWorker = roster({
    workerId: 'w1',
    worker: {
      ...roster({ workerId: 'w1' }).worker,
      hireDate: '2024-06-10', // anniversary June 10 lands in the 06-01..06-15 period
      healthAllowanceEligible: true,
    },
  });

  it('still builds a row and pays the ₱20k health allowance with zero time', () => {
    const attribution = attributeTimeEntries([], [haWorker]); // no approved time at all
    const rows = buildStatements({
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
      attribution,
      roster: [haWorker],
      rates: haRates,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result.workedHours).toBe(0);
    expect(rows[0]?.result.healthAllowance).toBe(2_000_000); // ₱20,000
    expect(rows[0]?.result.net).toBe(2_000_000);
    const draft = toPaymentDraft(rows[0] as NonNullable<(typeof rows)[0]>, { fxRate: undefined });
    expect(draft?.net_php).toBe(20000);
  });

  it('does NOT build a zero-time row outside the anniversary period', () => {
    const attribution = attributeTimeEntries([], [haWorker]);
    const rows = buildStatements({
      periodStart: '2026-07-01', // July — no anniversary, no time
      periodEnd: '2026-07-15',
      attribution,
      roster: [haWorker],
      rates: haRates,
    });
    expect(rows).toHaveLength(0);
  });

  it('does NOT build when the HA batch toggle is off', () => {
    const attribution = attributeTimeEntries([], [haWorker]);
    const rows = buildStatements({
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
      attribution,
      roster: [haWorker],
      rates: haRates,
      includeHealthAllowance: false,
    });
    expect(rows).toHaveLength(0);
  });
});

describe('money boundary helpers', () => {
  it('round-trips PHP ↔ centavos', () => {
    expect(phpToCentavos('12345.67')).toBe(1_234_567);
    expect(phpToCentavos(null)).toBeNull();
    expect(centavosToPhp(1_234_567 as never)).toBe(12345.67);
  });
});
