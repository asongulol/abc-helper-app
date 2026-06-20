import { describe, expect, it } from 'vitest';
import {
  computeInvoice,
  type RosterEntry,
  type WorkerSeconds,
  type WorkerSessions,
} from '@/lib/invoicing/compute';

const roster = (...entries: Array<Partial<RosterEntry> & { workerId: string }>): RosterEntry[] =>
  entries.map((e) => ({
    workerName: e.workerName ?? e.workerId,
    position: e.position ?? null,
    billRateUsd: e.billRateUsd ?? 0,
    ...e,
  }));

const time = (...entries: WorkerSeconds[]): WorkerSeconds[] => entries;
const sessions = (
  ...entries: Array<Partial<WorkerSessions> & { workerId: string; sessionsCount: number }>
): WorkerSessions[] =>
  entries.map((e) => ({
    workerName: e.workerName ?? e.workerId,
    position: e.position ?? null,
    sessionRateUsd: e.sessionRateUsd ?? null,
    ...e,
  }));

describe('computeInvoice — hourly', () => {
  it('bills worked hours × bill rate (1h @ $50 = $50.00)', () => {
    const r = computeInvoice(
      roster({
        workerId: 'w1',
        workerName: 'Ann',
        position: 'Dev',
        billRateUsd: 50,
      }),
      time({ workerId: 'w1', trackedSeconds: 3600 }),
      [],
      0,
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      kind: 'hourly',
      workedHours: 1,
      billRateUsd: 50,
      amount: 5000,
    });
    expect(r.subtotal).toBe(5000);
    expect(r.total).toBe(5000);
    expect(r.totalHours).toBe(1);
  });

  it('rounds the amount in integer cents (1.5h @ $33.33 = $50.00, not $49.99)', () => {
    const r = computeInvoice(
      roster({ workerId: 'w1', workerName: 'Ann', billRateUsd: 33.33 }),
      time({ workerId: 'w1', trackedSeconds: 5400 }),
      [],
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
      [],
      0,
    );
    expect(r.lines[0]?.workedHours).toBe(1);
    expect(r.lines[0]?.amount).toBe(4000);
  });

  it('applies markup to the total only (10% on $100 = $110)', () => {
    const r = computeInvoice(
      roster({ workerId: 'w1', workerName: 'Ann', billRateUsd: 100 }),
      time({ workerId: 'w1', trackedSeconds: 3600 }),
      [],
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
      [],
      0,
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      workerId: 'w1',
      workedHours: 1,
      amount: 0,
    });
    expect(r.subtotal).toBe(0);
  });

  it('sorts lines by contractor name and totals across them', () => {
    const r = computeInvoice(
      roster(
        { workerId: 'w2', workerName: 'Zoe', billRateUsd: 10 },
        { workerId: 'w1', workerName: 'Ann', billRateUsd: 10 },
      ),
      time({ workerId: 'w1', trackedSeconds: 3600 }, { workerId: 'w2', trackedSeconds: 7200 }),
      [],
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
      [],
      Number.NaN,
    );
    expect(r.total).toBe(r.subtotal);
    expect(r.markupPct).toBe(0);
  });
});

describe('computeInvoice — sessions (flat fee)', () => {
  it('bills a flat fee per session, ignoring duration (3 × $75 = $225.00)', () => {
    const r = computeInvoice(
      [], // empty roster — sessions bill independently of roster membership
      [],
      sessions({ workerId: 'w1', workerName: 'Ann', sessionsCount: 3, sessionRateUsd: 75 }),
      0,
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      kind: 'session',
      sessionsCount: 3,
      sessionRateUsd: 75,
      workedHours: 0,
      amount: 22500,
    });
    expect(r.subtotal).toBe(22500);
    expect(r.totalSessions).toBe(3);
  });

  it('sums session units per worker (2 + 1 = 3 @ $50 = $150)', () => {
    const r = computeInvoice(
      [],
      [],
      sessions(
        { workerId: 'w1', workerName: 'Ann', sessionsCount: 2, sessionRateUsd: 50 },
        { workerId: 'w1', workerName: 'Ann', sessionsCount: 1, sessionRateUsd: 50 },
      ),
      0,
    );
    expect(r.lines[0]?.sessionsCount).toBe(3);
    expect(r.lines[0]?.amount).toBe(15000);
  });

  it('bills an approved session even when the worker is NOT on the active roster', () => {
    // Regression: session lines must not be gated on active-roster membership —
    // an approved session for a deactivated/ended link still bills.
    const r = computeInvoice(
      [], // worker absent from the active roster
      [],
      sessions({ workerId: 'w-ended', workerName: 'Gone', sessionsCount: 2, sessionRateUsd: 40 }),
      0,
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ kind: 'session', workerId: 'w-ended', amount: 8000 });
  });

  it('keeps zero-rate session lines (billed $0) but drops zero-count', () => {
    const r = computeInvoice(
      [],
      [],
      sessions(
        { workerId: 'w1', workerName: 'Ann', sessionsCount: 2, sessionRateUsd: null }, // no rate → $0, kept
        { workerId: 'w2', workerName: 'Bob', sessionsCount: 0, sessionRateUsd: 40 }, // no sessions → dropped
      ),
      0,
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      kind: 'session',
      workerId: 'w1',
      sessionsCount: 2,
      amount: 0,
    });
    expect(r.subtotal).toBe(0);
  });

  it('is cent-accurate (3 × $33.33 = $99.99)', () => {
    const r = computeInvoice(
      [],
      [],
      sessions({ workerId: 'w1', workerName: 'Ann', sessionsCount: 3, sessionRateUsd: 33.33 }),
      0,
    );
    expect(r.lines[0]?.amount).toBe(9999);
  });
});

describe('computeInvoice — mixed hourly + session', () => {
  it('emits two lines for a worker with both hours and sessions', () => {
    const r = computeInvoice(
      roster({ workerId: 'w1', workerName: 'Ann', billRateUsd: 50 }),
      time({ workerId: 'w1', trackedSeconds: 3600 }), // 1h × $50 = $50
      sessions({ workerId: 'w1', workerName: 'Ann', sessionsCount: 2, sessionRateUsd: 75 }), // 2 × $75 = $150
      0,
    );
    expect(r.lines).toHaveLength(2);
    expect(r.lines.map((l) => l.kind).sort()).toEqual(['hourly', 'session']);
    expect(r.subtotal).toBe(20000);
    expect(r.totalHours).toBe(1);
    expect(r.totalSessions).toBe(2);
  });

  it('applies markup once to the COMBINED subtotal ($100 hourly + $100 session, 10% → $220)', () => {
    const r = computeInvoice(
      roster({ workerId: 'w1', workerName: 'Ann', billRateUsd: 100 }),
      time({ workerId: 'w1', trackedSeconds: 3600 }), // 1h × $100 = $100
      sessions({ workerId: 'w1', workerName: 'Ann', sessionsCount: 2, sessionRateUsd: 50 }), // 2 × $50 = $100
      10,
    );
    expect(r.subtotal).toBe(20000);
    expect(r.total).toBe(22000); // 20000 × 1.1, not 11000 + 11000 computed separately
  });
});
