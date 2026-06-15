import { type RosterEntry, type WorkerSeconds, computeInvoice } from '@/lib/invoicing/compute';
import { describe, expect, it } from 'vitest';

const roster = (...entries: Array<Partial<RosterEntry> & { workerId: string }>): RosterEntry[] =>
  entries.map((e) => ({
    workerName: e.workerName ?? e.workerId,
    position: e.position ?? null,
    billRateUsd: e.billRateUsd ?? 0,
    ...e,
  }));

const time = (...entries: WorkerSeconds[]): WorkerSeconds[] => entries;

describe('computeInvoice', () => {
  it('bills worked hours × bill rate (1h @ $50 = $50.00)', () => {
    const r = computeInvoice(
      roster({ workerId: 'w1', workerName: 'Ann', position: 'Dev', billRateUsd: 50 }),
      time({ workerId: 'w1', trackedSeconds: 3600 }),
      0,
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ workedHours: 1, billRateUsd: 50, amount: 5000 });
    expect(r.subtotal).toBe(5000);
    expect(r.total).toBe(5000);
    expect(r.totalHours).toBe(1);
  });

  it('rounds the amount in integer cents (1.5h @ $33.33 = $50.00, not $49.99)', () => {
    const r = computeInvoice(
      roster({ workerId: 'w1', workerName: 'Ann', billRateUsd: 33.33 }),
      time({ workerId: 'w1', trackedSeconds: 5400 }),
      0,
    );
    expect(r.lines[0]?.workedHours).toBe(1.5);
    expect(r.lines[0]?.amount).toBe(5000); // round(3333 × 1.5) = round(4999.5) = 5000
    expect(r.subtotal).toBe(5000);
  });

  it('sums multiple time rows per worker (PTO is never passed in)', () => {
    const r = computeInvoice(
      roster({ workerId: 'w1', workerName: 'Ann', billRateUsd: 40 }),
      time({ workerId: 'w1', trackedSeconds: 1800 }, { workerId: 'w1', trackedSeconds: 1800 }),
      0,
    );
    expect(r.lines[0]?.workedHours).toBe(1);
    expect(r.lines[0]?.amount).toBe(4000);
  });

  it('applies markup to the total only (10% on $100 = $110)', () => {
    const r = computeInvoice(
      roster({ workerId: 'w1', workerName: 'Ann', billRateUsd: 100 }),
      time({ workerId: 'w1', trackedSeconds: 3600 }),
      10,
    );
    expect(r.subtotal).toBe(10000);
    expect(r.total).toBe(11000);
    expect(r.markupPct).toBe(10);
  });

  it('drops zero-hour contractors but keeps zero-rate lines (billed $0)', () => {
    const r = computeInvoice(
      roster(
        { workerId: 'w1', workerName: 'Ann', billRateUsd: 0 }, // no rate → $0 line, kept
        { workerId: 'w2', workerName: 'Bob', billRateUsd: 50 }, // no hours → dropped
      ),
      time({ workerId: 'w1', trackedSeconds: 3600 }),
      0,
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ workerId: 'w1', workedHours: 1, amount: 0 });
    expect(r.subtotal).toBe(0);
  });

  it('sorts lines by contractor name and totals across them', () => {
    const r = computeInvoice(
      roster(
        { workerId: 'w2', workerName: 'Zoe', billRateUsd: 10 },
        { workerId: 'w1', workerName: 'Ann', billRateUsd: 10 },
      ),
      time({ workerId: 'w1', trackedSeconds: 3600 }, { workerId: 'w2', trackedSeconds: 7200 }),
      0,
    );
    expect(r.lines.map((l) => l.workerName)).toEqual(['Ann', 'Zoe']);
    expect(r.subtotal).toBe(r.lines.reduce((s, l) => s + l.amount, 0));
    expect(r.subtotal).toBe(3000); // (1h + 2h) × $10
  });

  it('treats a negative/blank markup as zero', () => {
    const r = computeInvoice(
      roster({ workerId: 'w1', workerName: 'Ann', billRateUsd: 25 }),
      time({ workerId: 'w1', trackedSeconds: 3600 }),
      Number.NaN,
    );
    expect(r.total).toBe(r.subtotal);
    expect(r.markupPct).toBe(0);
  });
});
