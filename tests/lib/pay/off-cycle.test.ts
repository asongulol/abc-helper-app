import { describe, expect, it } from 'vitest';
import { centavos } from '@/lib/money';
import { calcContractorRow } from '@/lib/pay/calc';
import {
  attributeTimeEntries,
  buildStatements,
  type RosterRow,
  type TimeEntryRow,
} from '@/lib/payroll/mappers';
import { type EditableRowValues, recomputeNetCentavos } from '@/lib/payroll/row-net';

const PERIOD = { periodStart: '2026-06-01', periodEnd: '2026-06-15' };

const roster = (over: Partial<RosterRow> & { workerId: string }): RosterRow => ({
  contract: 'PHS',
  payBasis: 'per_session',
  hubstaffName: null,
  linkStatus: 'active',
  worker: {
    firstName: 'Maria',
    middleName: null,
    lastName: 'Santos',
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

describe('offCycleEarnings (calcContractorRow)', () => {
  it('omitted ⇒ parity: net unchanged, offCycle is 0', () => {
    const r = calcContractorRow({
      workedSeconds: 88 * 3600,
      contract: 'FT',
      rate: centavos(1_500_000),
      ...PERIOD,
    });
    expect(r.offCycle).toBe(0);
    expect(r.net).toBe(1_500_000);
  });

  it('adds to net and surfaces on result.offCycle', () => {
    const r = calcContractorRow({
      workedSeconds: 88 * 3600,
      contract: 'FT',
      rate: centavos(1_500_000),
      offCycleEarnings: centavos(50_000), // ₱500
      ...PERIOD,
    });
    expect(r.offCycle).toBe(50_000);
    expect(r.net).toBe(1_550_000);
  });

  it('pays an off-cycle-only per-session worker with zero in-period units', () => {
    const r = calcContractorRow({
      workedSeconds: 0,
      sessionUnits: 0,
      contract: 'PHS',
      payBasis: 'per_session',
      rate: centavos(50_000),
      offCycleEarnings: centavos(150_000), // 3 sessions × ₱500
      ...PERIOD,
    });
    expect(r.gross).toBe(0);
    expect(r.offCycle).toBe(150_000);
    expect(r.net).toBe(150_000);
  });

  it('stays null (unpayable) when gross is null even with off-cycle set', () => {
    const r = calcContractorRow({
      workedSeconds: 0,
      contract: 'PHS',
      payBasis: null, // unset ⇒ gross null
      rate: centavos(50_000),
      offCycleEarnings: centavos(150_000),
      ...PERIOD,
    });
    expect(r.gross).toBeNull();
    expect(r.net).toBeNull();
  });
});

describe('buildStatements offCycleByWorker', () => {
  it('flows the off-cycle total into the draft off_cycle_php and net', () => {
    const rows = buildStatements({
      ...PERIOD,
      attribution: attributeTimeEntries([], [roster({ workerId: 'w1' })]),
      roster: [roster({ workerId: 'w1' })],
      rates: [{ workerId: 'w1', amountPhp: 500, effectiveStart: '2026-01-01', effectiveEnd: null }],
      sessionsByWorker: new Map([['w1', 0]]),
      offCycleByWorker: new Map([['w1', centavos(150_000)]]),
    });
    // off-cycle-only worker still gets a row
    expect(rows).toHaveLength(1);
    expect(rows[0].result.offCycle).toBe(150_000);
    expect(rows[0].result.net).toBe(150_000);
  });
});

describe('attributeTimeEntries per-hour off-cycle date exclusion', () => {
  it('drops a (worker, date) already paid off-cycle so it is not double-paid', () => {
    const entries = [
      entry({ workerId: 'w1', workDate: '2026-06-10', trackedSeconds: 4 * 3600 }),
      entry({ workerId: 'w1', workDate: '2026-06-11', trackedSeconds: 5 * 3600 }),
    ];
    const r = roster({ workerId: 'w1', contract: 'PHS', payBasis: 'hourly' });
    const exclude = new Map([['w1', new Set(['2026-06-10'])]]);
    const res = attributeTimeEntries(entries, [r], exclude);
    // only 2026-06-11's 5h remains
    expect(res.secondsByWorker.get('w1')).toBe(5 * 3600);
    expect(res.secondsByWorkerByDate.get('w1')?.has('2026-06-10')).toBe(false);
  });

  it('without an exclude map, all days count (parity)', () => {
    const entries = [
      entry({ workerId: 'w1', workDate: '2026-06-10', trackedSeconds: 4 * 3600 }),
      entry({ workerId: 'w1', workDate: '2026-06-11', trackedSeconds: 5 * 3600 }),
    ];
    const res = attributeTimeEntries(entries, [roster({ workerId: 'w1' })]);
    expect(res.secondsByWorker.get('w1')).toBe(9 * 3600);
  });
});

describe('recomputeNetCentavos includes off-cycle', () => {
  const base: EditableRowValues = {
    grossPhp: 1000,
    haPhp: 0,
    t13Php: 0,
    pddPhp: 0,
    bonusPhp: 0,
    miscItems: [],
  };
  it('adds offCyclePhp into net', () => {
    expect(recomputeNetCentavos({ ...base, offCyclePhp: 500 })).toBe(150_000);
  });
  it('defaults to 0 when omitted (parity)', () => {
    expect(recomputeNetCentavos(base)).toBe(100_000);
  });
});
