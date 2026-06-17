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

describe('money boundary helpers', () => {
  it('round-trips PHP ↔ centavos', () => {
    expect(phpToCentavos('12345.67')).toBe(1_234_567);
    expect(phpToCentavos(null)).toBeNull();
    expect(centavosToPhp(1_234_567 as never)).toBe(12345.67);
  });
});
