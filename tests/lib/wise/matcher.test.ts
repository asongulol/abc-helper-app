/**
 * Unit tests for the pure Wise backfill matcher (src/lib/wise/matcher.ts).
 *
 * Edge-case coverage mapping (legacy source → test):
 *
 *  exact match                    → 'exact amount match — single candidate'
 *  ±1 peso boundary (inside)      → '₱1.00 tolerance — exactly at boundary (inside)'
 *  ±1 peso boundary (outside)     → '₱1.01 over tolerance — treated as variance'
 *  outside-window rejection       → 'no period_end: transfer outside ±windowDays is rejected'
 *  legal arrears window (RP-04)   → describe 'decideMatch — legal payment window'
 *  multi-candidate closest-date   → 'multiple exact-amount candidates — closest pay_date wins'
 *  ghost cancelled excluded       → 'cancelled transfers are excluded before indexing'
 *  recipient-history union        → 'historical recipient id in wise_recipients matched'
 *  variance auto-override         → 'unambiguous variance auto-overrides net_php'
 *  orphan suggestion output       → 'orphan transfer is suggested for unmatched payment'
 *  true tie ambiguous             → 'true tie in exact-amount multi-candidate → ambiguous_exact'
 *  refresh fast-path              → 'refresh path re-applies dates without re-matching'
 *  refresh not-in-history         → 'refresh: stored id not found in pull window'
 *  no recipient keys              → 'no recipient keys stored → no_recipient'
 *  no transfers for recipient     → 'no transfers for any recipient key → no_wise_transfer'
 *  ambiguous variance             → 'multiple variance candidates — matched_with_variance (no override)'
 */

import { describe, expect, it } from 'vitest';
import { majorToMinor } from '@/lib/money';
import {
  annotateOrphans,
  buildRecipientIndex,
  buildTransferIdIndex,
  decideMatch,
  decideRefresh,
  filterLive,
} from '@/lib/wise/matcher';
import type { MatcherPayment, WiseDates, WiseTransfer } from '@/lib/wise/types';

// ─── test fixtures ────────────────────────────────────────────────────────────

const NOW_ISO = '2026-06-12T00:00:00.000Z';
const PAY_DATE = '2026-06-12';
const PAY_DATE_MS = new Date(PAY_DATE).getTime();
const DAY_MS = 86_400_000;

/** Build a minimal WiseTransfer. */
function makeTransfer(
  id: number,
  recipientId: number,
  targetValue: number,
  createdDaysFromPayDate: number,
  status = 'outgoing_payment_sent',
): WiseTransfer {
  const createdMs = PAY_DATE_MS + createdDaysFromPayDate * DAY_MS;
  return {
    id,
    status,
    targetAccount: recipientId,
    targetValue,
    created: new Date(createdMs).toISOString(),
  };
}

/** Build a minimal MatcherPayment. */
function makePayment(
  id: string,
  netPhp: number,
  recipientId: number,
  opts: {
    originalNetPhp?: number | null;
    status?: string;
    wiseTransferId?: string | null;
    payDate?: string;
    periodStart?: string;
    periodEnd?: string;
    paidAt?: string;
  } = {},
): MatcherPayment {
  return {
    id,
    worker_id: `worker-${id}`,
    net_php: netPhp,
    original_net_php: opts.originalNetPhp ?? null,
    status: opts.status ?? 'draft',
    wise_transfer_id: opts.wiseTransferId ?? null,
    ...(opts.paidAt ? { paid_at: opts.paidAt } : {}),
    workers: {
      wise_recipient_id: recipientId,
      wise_recipient_uuid: null,
      wise_recipients: null,
    },
    pay_periods: {
      pay_date: opts.payDate ?? PAY_DATE,
      period_start: opts.periodStart ?? null,
      period_end: opts.periodEnd ?? null,
    },
  };
}

/** A real semi-monthly row: work Mar 1–15, deadline Mar 31 → legal send Mar 16–31. */
function makeArrearsPayment(
  id: string,
  netPhp: number,
  recipientId: number,
  opts: { paidAt?: string; periodStart?: string } = {},
): MatcherPayment {
  return makePayment(id, netPhp, recipientId, {
    periodEnd: '2026-03-15',
    payDate: '2026-03-31',
    ...opts,
  });
}

/** Transfer created on a given calendar date (mid-morning UTC). */
function makeTransferOn(id: number, recipientId: number, targetValue: number, date: string) {
  return {
    ...makeTransfer(id, recipientId, targetValue, 0),
    created: `${date}T10:00:00.000Z`,
  };
}

/** No-op getDates function (sync, no network). */
const noopDates = (_t: WiseTransfer): WiseDates => ({
  created: _t.created ?? null,
  dateFunded: null,
  dateSent: null,
});

// ─── filterLive ───────────────────────────────────────────────────────────────

describe('filterLive', () => {
  it('excludes cancelled transfers and keeps everything else', () => {
    const transfers: WiseTransfer[] = [
      makeTransfer(1, 100, 20000, 0, 'outgoing_payment_sent'),
      makeTransfer(2, 100, 20000, 0, 'cancelled'),
      makeTransfer(3, 101, 30000, 0, 'processing'),
    ];
    const live = filterLive(transfers);
    expect(live.map((t) => t.id)).toEqual([1, 3]);
  });

  it('ghost cancelled excluded — same recipient+amount ghost does not cause ambiguity', () => {
    // Scenario from the May 2026 batch: 13 sent + 12 cancelled for same recipients.
    const transfers: WiseTransfer[] = [
      makeTransfer(10, 200, 15000, 0, 'outgoing_payment_sent'),
      makeTransfer(11, 200, 15000, 0, 'cancelled'), // ghost
    ];
    const live = filterLive(transfers);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(10);
  });
});

// ─── buildRecipientIndex ──────────────────────────────────────────────────────

describe('buildRecipientIndex', () => {
  it('indexes by numeric targetAccount', () => {
    const t = makeTransfer(1, 999, 10000, 0);
    const idx = buildRecipientIndex([t]);
    expect(idx.get('999')).toEqual([t]);
  });

  it('indexes by recipientId (UUID) when present and different from targetAccount', () => {
    const t: WiseTransfer = {
      ...makeTransfer(1, 999, 10000, 0),
      recipientId: 'uuid-abc',
    };
    const idx = buildRecipientIndex([t]);
    expect(idx.get('999')).toHaveLength(1);
    expect(idx.get('uuid-abc')).toHaveLength(1);
  });
});

// ─── decideMatch — no_recipient ───────────────────────────────────────────────

describe('decideMatch — no recipient keys', () => {
  it('returns no_recipient when worker has no recipient info', () => {
    const p: MatcherPayment = {
      id: 'p1',
      worker_id: 'w1',
      net_php: 10000,
      original_net_php: null,
      status: 'draft',
      wise_transfer_id: null,
      workers: {
        wise_recipient_id: null,
        wise_recipient_uuid: null,
        wise_recipients: null,
      },
      pay_periods: { pay_date: PAY_DATE, period_end: null },
    };
    const idx = new Map<string, WiseTransfer[]>();
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('no_recipient');
    expect(d.patch).toBeUndefined();
  });
});

// ─── decideMatch — no transfers ───────────────────────────────────────────────

describe('decideMatch — no transfers for recipient', () => {
  it('returns no_wise_transfer when index has no entry for this recipient', () => {
    const p = makePayment('p1', 10000, 999);
    const idx = new Map<string, WiseTransfer[]>();
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('no_wise_transfer');
  });

  // These two rows carry NO period_end, so there is no legal window to derive and
  // windowDays is the whole story — the legacy ±windowDays fallback path.
  it('no period_end: transfer outside ±windowDays is rejected → no_wise_transfer_in_window', () => {
    const t = makeTransfer(1, 999, 10000, 10); // 10 days after pay_date, window=7
    const idx = buildRecipientIndex([t]);
    const p = makePayment('p1', 10000, 999);
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('no_wise_transfer_in_window');
  });

  it('no period_end: transfer exactly at ±windowDays boundary is included', () => {
    const t = makeTransfer(1, 999, 10000, 7); // exactly 7 days after — borderline
    const idx = buildRecipientIndex([t]);
    const p = makePayment('p1', 10000, 999);
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    // 7 * DAY_MS = exactly windowDays * DAY_MS → included (<=)
    expect(d.result.outcome).toBe('matched_exact');
  });
});

// ─── decideMatch — the legal payment window (RP-04) ───────────────────────────
//
// THE OLD ASSERTION HERE WAS WRONG. These tests used to say "±7 days of pay_date
// is the window" and treated a transfer 10 days off pay_date as correctly rejected.
// That contradicts the pay schedule: semi-monthly, half-month arrears, with
// pay_date a DEADLINE rather than an appointment — work on Mar 1–15 may legally be
// sent on ANY day from Mar 16 to Mar 31. A ±7d window around Mar 31 covers
// Mar 24–Apr 7 and rejects the perfectly legal Mar 17 transfer as
// no_wise_transfer_in_window.
//
// The window is now the row's own [period_start, pay_date + slack], with
// windowDays as a floor. Please don't "restore" the ±7d boundary: it only ever
// looked right because these fixtures had no period_end. See matchWindow() in
// src/lib/wise/matcher.ts.

describe('decideMatch — legal payment window (semi-monthly arrears)', () => {
  /** Outcome for a ₱10,000 arrears row whose only transfer was created on `created`. */
  const outcomeFor = (created: string, windowDays = 7): string => {
    const idx = buildRecipientIndex([makeTransferOn(1, 999, 10000, created)]);
    return decideMatch(makeArrearsPayment('p1', 10000, 999), idx, noopDates, windowDays, NOW_ISO)
      .result.outcome;
  };

  it('transfer on the FIRST legal day (period_end + 1) matches', () => {
    expect(outcomeFor('2026-03-16')).toBe('matched_exact');
  });

  it('transfer on the LAST legal day (the pay_date deadline itself) matches', () => {
    expect(outcomeFor('2026-03-31')).toBe('matched_exact');
  });

  it('RP-04 scenario: Mar 1–15 period, deadline Mar 31, sent Mar 17, never marked paid', () => {
    expect(outcomeFor('2026-03-17')).toBe('matched_exact');
  });

  it('does NOT swallow the NEXT period transfer of the same amount', () => {
    // Apr 5 is inside the Mar 16–31 period's legal window, not this row's.
    expect(outcomeFor('2026-04-05')).toBe('no_wise_transfer_in_window');
  });

  it('does NOT swallow the PREVIOUS period transfer of the same amount', () => {
    // Mar 5 belongs to the Feb 16–28 period (paid Mar 1–15).
    expect(outcomeFor('2026-03-05')).toBe('no_wise_transfer_in_window');
  });

  it('paid_at still wins over the legal window — a late send anchors on the real date', () => {
    const t = makeTransferOn(1, 999, 10000, '2026-04-20'); // well past the deadline
    const p = makeArrearsPayment('p1', 10000, 999, {
      paidAt: '2026-04-20T10:00:00.000Z',
    });
    const d = decideMatch(p, buildRecipientIndex([t]), noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('matched_exact');
  });

  it('paid_at only ever WIDENS — it cannot push a legal-window transfer out', () => {
    // This assertion used to be the opposite ("paid_at narrows as well as
    // widens"). It can't be: the app writes paid_at from whichever transfer got
    // matched, so a wrong link poisons it — that is how 36 transfers ended up on
    // two payments each. A date the row derived from a guess must not veto the
    // schedule's own window.
    const t = makeTransferOn(1, 999, 10000, '2026-03-20'); // inside the legal window…
    const p = makeArrearsPayment('p1', 10000, 999, {
      paidAt: '2026-04-20T10:00:00.000Z',
    }); // …but the row records Apr 20
    const d = decideMatch(p, buildRecipientIndex([t]), noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('matched_exact');
  });

  it('a transfer sent BEFORE period_end still matches (prod: Zagado, paid 2 days early)', () => {
    // Verified counter-example to "after period_end" as a hard floor: Zagado's
    // 2024-08-01→15 row was paid on Aug 13. The floor is period_start.
    const p = makeArrearsPayment('p1', 10000, 999, {
      periodStart: '2026-03-01',
    });
    const early = makeTransferOn(1, 999, 10000, '2026-03-13');
    expect(decideMatch(p, buildRecipientIndex([early]), noopDates, 7, NOW_ISO).result.outcome).toBe(
      'matched_exact',
    );
  });

  it('the previous period’s transfer is in window but loses the rank to this one', () => {
    // period_start opens the window wide enough to admit the Feb 16–28 period's
    // transfer (sent Mar 5). Eligible, but ranked behind the one that landed
    // inside THIS row's legal send window.
    const p = makeArrearsPayment('p1', 10000, 999, {
      periodStart: '2026-03-01',
    });
    const previous = makeTransferOn(1, 999, 10000, '2026-03-05');
    const ours = makeTransferOn(2, 999, 10000, '2026-03-27');
    const d = decideMatch(p, buildRecipientIndex([previous, ours]), noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('matched_closest_date');
    expect('transfer_id' in d.result && d.result.transfer_id).toBe('2');
  });

  it('pre-RP-03 rows (pay_date overwritten with period_end) degrade to the legacy ±windowDays', () => {
    // lockPeriod used to write period_end into pay_date, so the span is zero and
    // the real deadline is unrecoverable — behave exactly as before the fix.
    const p = makePayment('p1', 10000, 999, {
      periodEnd: '2026-03-15',
      payDate: '2026-03-15',
    });
    const inside = makeTransferOn(1, 999, 10000, '2026-03-20'); // within ±7d of Mar 15
    const outside = makeTransferOn(2, 999, 10000, '2026-03-30'); // 15d out — still missed
    expect(
      decideMatch(p, buildRecipientIndex([inside]), noopDates, 7, NOW_ISO).result.outcome,
    ).toBe('matched_exact');
    expect(
      decideMatch(p, buildRecipientIndex([outside]), noopDates, 7, NOW_ISO).result.outcome,
    ).toBe('no_wise_transfer_in_window');
  });

  it('windowDays stays a floor — a caller-widened window still applies', () => {
    // Apr 5 is outside the legal window but inside ±30d of its midpoint.
    expect(outcomeFor('2026-04-05', 30)).toBe('matched_exact');
  });
});

// ─── decideMatch — paid_at anchors the window ─────────────────────────────────
//
// A batch marked paid two weeks after the scheduled pay_date (real prod case:
// pay_date 06-15, paid_at 06-29) must window around paid_at, or every real
// transfer lands outside ±7d of pay_date and comes back
// no_wise_transfer_in_window.

describe('decideMatch — paid_at anchors the window', () => {
  it('transfer near paid_at but outside the pay_date window still matches', () => {
    const t = makeTransfer(1, 999, 10000, 14); // 14 days after pay_date…
    const idx = buildRecipientIndex([t]);
    const paidAt = new Date(PAY_DATE_MS + 14 * DAY_MS).toISOString(); // …but ON paid_at
    const p = makePayment('p1', 10000, 999, { paidAt });
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('matched_exact');
  });

  it('without paid_at the same transfer stays outside the window (fallback unchanged)', () => {
    const t = makeTransfer(1, 999, 10000, 14);
    const idx = buildRecipientIndex([t]);
    const p = makePayment('p1', 10000, 999);
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('no_wise_transfer_in_window');
  });
});

// ─── decideMatch — exact match ────────────────────────────────────────────────

describe('decideMatch — exact match', () => {
  it('exact amount match — single candidate returns matched_exact', () => {
    const t = makeTransfer(1, 999, 20000, 0);
    const idx = buildRecipientIndex([t]);
    const p = makePayment('p1', 20000, 999);
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('matched_exact');
    expect('transfer_id' in d.result && d.result.transfer_id).toBe('1');
    expect(d.patch?.wise_transfer_id).toBe('1');
  });

  it('₱1.00 tolerance — exactly at boundary (inside) → matched_exact', () => {
    // 100 centavos = ₱1.00 — right at the edge.
    const netPhp = 20000;
    const wisePhp = netPhp + 1.0; // exactly ₱1 over — still within tolerance
    expect(Math.abs(majorToMinor(wisePhp) - majorToMinor(netPhp))).toBe(100); // = TOLERANCE_CENTAVOS
    const t = makeTransfer(1, 999, wisePhp, 0);
    const idx = buildRecipientIndex([t]);
    const p = makePayment('p1', netPhp, 999);
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('matched_exact');
  });

  it('₱1.01 over tolerance — treated as variance', () => {
    const netPhp = 20000;
    const wisePhp = netPhp + 1.01;
    // centavo delta = 101 > 100 → outside tolerance
    expect(Math.abs(majorToMinor(wisePhp) - majorToMinor(netPhp))).toBeGreaterThan(100);
    const t = makeTransfer(1, 999, wisePhp, 0);
    const idx = buildRecipientIndex([t]);
    const p = makePayment('p1', netPhp, 999);
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    // single in-window candidate with amount outside tolerance → unambiguous variance
    expect(d.result.outcome).toBe('matched_with_variance_overridden');
  });
});

// ─── decideMatch — multi-candidate closest-date ───────────────────────────────

describe('decideMatch — multiple exact-amount candidates', () => {
  it('closest pay_date wins when two candidates in window', () => {
    // Two transfers with same amount, same recipient, both in window.
    // t1 is 2 days after pay_date, t2 is 5 days after — t1 should win.
    const t1 = makeTransfer(1, 999, 20000, 2);
    const t2 = makeTransfer(2, 999, 20000, 5);
    const idx = buildRecipientIndex([t1, t2]);
    const p = makePayment('p1', 20000, 999);
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('matched_closest_date');
    expect('transfer_id' in d.result && d.result.transfer_id).toBe('1');
  });

  it('true tie in exact-amount multi-candidate → ambiguous_exact', () => {
    // Both created exactly on the pay_date (0 days offset) → true tie (< 1 DAY_MS).
    const t1 = makeTransfer(1, 999, 20000, 0);
    const t2 = makeTransfer(2, 999, 20000, 0);
    const idx = buildRecipientIndex([t1, t2]);
    const p = makePayment('p1', 20000, 999);
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('ambiguous_exact');
    expect(d.patch).toBeUndefined();
    if (d.result.outcome === 'ambiguous_exact') {
      expect(d.result.candidate_transfer_ids).toHaveLength(2);
    }
  });

  it('candidates 1 day apart around pay_date — NOT a tie → closest wins', () => {
    // t1: 1h after pay_date, t2: 25h after pay_date → delta > 1 DAY_MS → t1 wins
    const t1CreatedMs = PAY_DATE_MS + 1 * 3600 * 1000; // 1h after
    const t2CreatedMs = PAY_DATE_MS + 25 * 3600 * 1000; // 25h after
    const t1: WiseTransfer = {
      id: 1,
      status: 'outgoing_payment_sent',
      targetAccount: 999,
      targetValue: 20000,
      created: new Date(t1CreatedMs).toISOString(),
    };
    const t2: WiseTransfer = {
      id: 2,
      status: 'outgoing_payment_sent',
      targetAccount: 999,
      targetValue: 20000,
      created: new Date(t2CreatedMs).toISOString(),
    };
    const idx = buildRecipientIndex([t1, t2]);
    const p = makePayment('p1', 20000, 999);
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('matched_closest_date');
    expect('transfer_id' in d.result && d.result.transfer_id).toBe('1');
  });
});

// ─── decideMatch — variance paths ─────────────────────────────────────────────

describe('decideMatch — variance', () => {
  it('unambiguous variance auto-overrides net_php and sets original_net_php', () => {
    // Only one transfer in window, amount outside ±₱1 → auto-override.
    const netPhp = 20000;
    const wisePhp = 19500; // ₱500 difference
    const t = makeTransfer(1, 999, wisePhp, 0);
    const idx = buildRecipientIndex([t]);
    const p = makePayment('p1', netPhp, 999);
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('matched_with_variance_overridden');
    expect(d.patch?.original_net_php).toBe(netPhp);
    expect(d.patch?.net_php).toBe(wisePhp);
  });

  it('does NOT re-override when original_net_php already set (idempotent)', () => {
    const netPhp = 20000;
    const wisePhp = 19500;
    const t = makeTransfer(1, 999, wisePhp, 0);
    const idx = buildRecipientIndex([t]);
    // Payment already has original_net_php set from a prior run.
    const p = makePayment('p1', wisePhp, 999, { originalNetPhp: netPhp });
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('matched_exact'); // wisePhp == net_php now
    expect(d.patch?.original_net_php).toBeUndefined();
  });

  it('multiple variance candidates — matched_with_variance (no amount override)', () => {
    // Two transfers to same recipient, both in window, neither within ±₱1.
    // Should NOT auto-override (ambiguous which one is correct).
    const t1 = makeTransfer(1, 999, 19000, 1); // ₱1000 off
    const t2 = makeTransfer(2, 999, 19500, 3); // ₱500 off — closer
    const idx = buildRecipientIndex([t1, t2]);
    const p = makePayment('p1', 20000, 999);
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('matched_with_variance');
    // No amount override on ambiguous variance.
    expect(d.patch?.original_net_php).toBeUndefined();
    expect(d.patch?.net_php).toBeUndefined();
    // Closest-amount (t2 = ₱19,500) picked as the write target.
    expect(d.patch?.wise_transfer_id).toBe('2');
  });
});

// ─── decideMatch — one transfer pays one row ──────────────────────────────────

describe('decideMatch — successful and unclaimed candidates only', () => {
  it('a non-successful transfer never links a row', () => {
    // Live (not cancelled) but still in flight — nothing was paid with it yet.
    const t = makeTransfer(1, 999, 20000, 0, 'processing');
    const d = decideMatch(
      makePayment('p1', 20000, 999),
      buildRecipientIndex([t]),
      noopDates,
      7,
      NOW_ISO,
    );
    expect(d.result.outcome).toBe('no_wise_transfer');
    expect(d.patch).toBeUndefined();
    expect('reason' in d.result && d.result.reason).toContain('processing');
  });

  it('a transfer already handed to an earlier row is not offered to this one', () => {
    // Two periods of the same flat-rate contractor, one transfer. Without the
    // claim set both rows link to it — 36 transfers in prod sit on two rows each.
    const t = makeTransfer(1, 999, 10000, 0);
    const idx = buildRecipientIndex([t]);
    const first = decideMatch(makePayment('p1', 10000, 999), idx, noopDates, 7, NOW_ISO, new Set());
    expect(first.patch?.wise_transfer_id).toBe('1');

    const second = decideMatch(
      makePayment('p2', 10000, 999),
      idx,
      noopDates,
      7,
      NOW_ISO,
      new Set(['1']),
    );
    expect(second.result.outcome).toBe('no_wise_transfer');
    expect(second.patch).toBeUndefined();
  });
});

// ─── recipient-history union ──────────────────────────────────────────────────

describe('recipient history union', () => {
  it('historical recipient id in wise_recipients matched after a bank change', () => {
    // Worker changed banks: current wise_recipient_id = 999 (new bank).
    // Old recipient id = 888 is in wise_recipients.
    // The historical transfer was to recipient 888.
    const oldRecipientTransfer = makeTransfer(50, 888, 20000, 0);
    const idx = buildRecipientIndex([oldRecipientTransfer]);

    const p: MatcherPayment = {
      id: 'p1',
      worker_id: 'w1',
      net_php: 20000,
      original_net_php: null,
      status: 'draft',
      wise_transfer_id: null,
      workers: {
        wise_recipient_id: 999, // new bank — no transfer here
        wise_recipient_uuid: null,
        wise_recipients: [{ id: 888 }], // old bank — transfer IS here
      },
      pay_periods: { pay_date: PAY_DATE, period_end: null },
    };

    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('matched_exact');
    expect('transfer_id' in d.result && d.result.transfer_id).toBe('50');
  });

  it('UUID recipient key is also tried', () => {
    const t: WiseTransfer = {
      id: 77,
      status: 'outgoing_payment_sent',
      targetAccount: null,
      recipientId: 'uuid-xyz',
      targetValue: 15000,
      created: new Date(PAY_DATE_MS).toISOString(),
    };
    const idx = buildRecipientIndex([t]);
    const p: MatcherPayment = {
      id: 'p2',
      worker_id: 'w2',
      net_php: 15000,
      original_net_php: null,
      status: 'draft',
      wise_transfer_id: null,
      workers: {
        wise_recipient_id: null,
        wise_recipient_uuid: 'uuid-xyz',
        wise_recipients: null,
      },
      pay_periods: { pay_date: PAY_DATE, period_end: null },
    };
    const d = decideMatch(p, idx, noopDates, 7, NOW_ISO);
    expect(d.result.outcome).toBe('matched_exact');
  });
});

// ─── refresh path ─────────────────────────────────────────────────────────────

describe('decideRefresh', () => {
  it('refresh path re-applies dates without re-matching recipient', () => {
    const t = makeTransfer(99, 999, 20000, 0);
    const idIndex = buildTransferIdIndex([t]);
    const p = makePayment('p1', 20000, 999, {
      wiseTransferId: '99',
      status: 'draft',
    });
    const dates: WiseDates = {
      created: '2026-06-12T10:00:00.000Z',
      dateFunded: null,
      dateSent: '2026-06-12T11:00:00.000Z',
    };
    const d = decideRefresh(p, idIndex, dates, NOW_ISO);
    expect(d.result.outcome).toBe('refreshed_clean');
    expect(d.patch?.wise_dates).toEqual(dates);
    expect(d.patch?.status).toBe('sent');
    expect(d.patch?.wise_locked_at).toBe(NOW_ISO);
  });

  it('refresh: stored id not found in pull window → refresh_transfer_not_in_history', () => {
    const idIndex = new Map<string, WiseTransfer>(); // empty — not pulled
    const p = makePayment('p1', 20000, 999, { wiseTransferId: '99' });
    const dates: WiseDates = {
      created: null,
      dateFunded: null,
      dateSent: null,
    };
    const d = decideRefresh(p, idIndex, dates, NOW_ISO);
    expect(d.result.outcome).toBe('refresh_transfer_not_in_history');
    expect(d.patch).toBeUndefined();
  });

  it('refresh variance auto-override preserves original_net_php (first run)', () => {
    const t = makeTransfer(99, 999, 19000, 0); // ₱19,000 — stored is ₱20,000
    const idIndex = buildTransferIdIndex([t]);
    const p = makePayment('p1', 20000, 999, {
      wiseTransferId: '99',
      originalNetPhp: null, // first run — not yet overridden
    });
    const dates: WiseDates = {
      created: NOW_ISO,
      dateFunded: null,
      dateSent: null,
    };
    const d = decideRefresh(p, idIndex, dates, NOW_ISO);
    expect(d.result.outcome).toBe('matched_with_variance_overridden');
    expect(d.patch?.original_net_php).toBe(20000);
    expect(d.patch?.net_php).toBe(19000);
  });

  it('refresh variance does NOT re-override when original_net_php already set', () => {
    const t = makeTransfer(99, 999, 19000, 0);
    const idIndex = buildTransferIdIndex([t]);
    const p = makePayment('p1', 19000, 999, {
      wiseTransferId: '99',
      originalNetPhp: 20000, // already overridden
    });
    const dates: WiseDates = {
      created: NOW_ISO,
      dateFunded: null,
      dateSent: null,
    };
    const d = decideRefresh(p, idIndex, dates, NOW_ISO);
    // net_php == wiseAmt (19000) → exact (original_net_php already set, check tolerance)
    // 19000 == 19000 centavos delta == 0 → within tolerance → refreshed_clean
    expect(d.result.outcome).toBe('refreshed_clean');
    expect(d.patch?.original_net_php).toBeUndefined();
  });

  it('refresh locks already-sent row even with non-terminal Wise status (2026-05-29 batch)', () => {
    // "In progress" in Wise despite money having already gone out (batch quirk).
    const t = makeTransfer(99, 999, 20000, 0, 'processing'); // not terminal
    const idIndex = buildTransferIdIndex([t]);
    const p = makePayment('p1', 20000, 999, {
      wiseTransferId: '99',
      status: 'sent', // recorded as sent by CSV import / prior poll
    });
    const dates: WiseDates = {
      created: NOW_ISO,
      dateFunded: null,
      dateSent: null,
    };
    const d = decideRefresh(p, idIndex, dates, NOW_ISO);
    // Should still lock (trusted recorded 'sent').
    expect(d.patch?.wise_locked_at).toBe(NOW_ISO);
    // Should NOT set status or paid_at (not terminal in Wise).
    expect(d.patch?.status).toBeUndefined();
  });
});

// ─── annotateOrphans ──────────────────────────────────────────────────────────

describe('annotateOrphans', () => {
  it('orphan transfer is suggested for unmatched payment', () => {
    const orphanTransfer = makeTransfer(200, 777, 10000, 0);
    const payment = makePayment('p1', 10000, 888); // recipient 888 — no transfer

    const unmatched = [
      {
        payment_id: 'p1',
        worker_id: 'w1',
        outcome: 'no_wise_transfer' as const,
        reason: 'no transfers',
        recipient_keys_tried: ['888'],
      },
    ];

    const payments = [payment];
    annotateOrphans(unmatched, payments, [orphanTransfer], 7);

    const r = unmatched[0];
    expect(r).toBeDefined();
    if (r && 'candidate_orphan_transfers' in r) {
      expect(r.candidate_orphan_transfers).toHaveLength(1);
      const candidate = r.candidate_orphan_transfers?.[0];
      expect(candidate?.transfer_id).toBe('200');
      expect(candidate?.ambiguous).toBe(false);
      expect(candidate?.shared_with_n_payments).toBe(1);
    } else {
      expect.fail('candidate_orphan_transfers not set on unmatched result');
    }
  });

  it('orphan shared by two unmatched payments is flagged ambiguous', () => {
    // One orphan transfer that matches both p1 and p2 (same amount + in window).
    const orphanTransfer = makeTransfer(300, 777, 10000, 0);
    const p1 = makePayment('p1', 10000, 888);
    const p2 = makePayment('p2', 10000, 999);

    const unmatched = [
      {
        payment_id: 'p1',
        worker_id: 'w1',
        outcome: 'no_wise_transfer' as const,
        reason: 'x',
        recipient_keys_tried: ['888'],
      },
      {
        payment_id: 'p2',
        worker_id: 'w2',
        outcome: 'no_wise_transfer' as const,
        reason: 'x',
        recipient_keys_tried: ['999'],
      },
    ];

    annotateOrphans(unmatched, [p1, p2], [orphanTransfer], 7);

    for (const r of unmatched) {
      if ('candidate_orphan_transfers' in r && r.candidate_orphan_transfers) {
        const candidate = r.candidate_orphan_transfers[0];
        expect(candidate?.ambiguous).toBe(true);
        expect(candidate?.shared_with_n_payments).toBe(2);
      }
    }
  });

  it('resolves the recipient name and marks the contractor hit', () => {
    // The whole point: recipient 777 is NOT on this contractor's profile, so the
    // primary matcher can never see this transfer — but Wise says the account
    // belongs to them, and the amount agrees.
    const orphan = makeTransfer(400, 777, 10000, 0);
    const p = { ...makePayment('p1', 10000, 888), worker_name: 'Ma. Luisa Marcelo' };
    const unmatched = [
      {
        payment_id: 'p1',
        worker_id: 'w1',
        outcome: 'no_wise_transfer' as const,
        reason: 'x',
        recipient_keys_tried: ['888'],
      },
    ];

    annotateOrphans(unmatched, [p], [orphan], 7, new Map([['777', 'Maria Luisa Marcelo']]));

    const c = unmatched[0]?.candidate_orphan_transfers?.[0];
    expect(c?.recipient_name).toBe('Maria Luisa Marcelo');
    expect(c?.name_matches).toBe(true);
  });

  it('a name hit reaches outside the date window; without one it does not', () => {
    const farOutside = makeTransfer(401, 777, 10000, 30);
    const p = { ...makePayment('p1', 10000, 888), worker_name: 'Jessica Aguilar' };
    const result = () => [
      {
        payment_id: 'p1',
        worker_id: 'w1',
        outcome: 'no_wise_transfer' as const,
        reason: 'x',
        recipient_keys_tried: ['888'],
      },
    ];

    const withName = result();
    annotateOrphans(withName, [p], [farOutside], 7, new Map([['777', 'Jessica Aguilar']]));
    expect(withName[0]?.candidate_orphan_transfers).toHaveLength(1);

    const noName = result();
    annotateOrphans(noName, [p], [farOutside], 7, new Map([['777', 'Someone Else']]));
    expect(noName[0]?.candidate_orphan_transfers).toBeUndefined();
  });

  it('a name hit breaks the tie two identical amounts cannot', () => {
    // Both payments are a round 10,000 on the same day — amount alone is a coin
    // flip, and that is exactly when auto-linking pays the wrong person.
    const orphan = makeTransfer(402, 777, 10000, 0);
    const p1 = { ...makePayment('p1', 10000, 888), worker_name: 'Kevin Llamoso' };
    const p2 = { ...makePayment('p2', 10000, 999), worker_name: 'Genel Montero' };
    const unmatched = [
      {
        payment_id: 'p1',
        worker_id: 'w1',
        outcome: 'no_wise_transfer' as const,
        reason: 'x',
        recipient_keys_tried: ['888'],
      },
      {
        payment_id: 'p2',
        worker_id: 'w2',
        outcome: 'no_wise_transfer' as const,
        reason: 'x',
        recipient_keys_tried: ['999'],
      },
    ];

    annotateOrphans(unmatched, [p1, p2], [orphan], 7, new Map([['777', 'Kevin Llamoso']]));

    // Offered to both — but only Kevin's is presented as unambiguous.
    expect(unmatched[0]?.candidate_orphan_transfers?.[0]?.ambiguous).toBe(false);
    expect(unmatched[1]?.candidate_orphan_transfers?.[0]?.ambiguous).toBe(true);
  });

  it('annotates an ambiguous row — the operator has to pick, so give it the list', () => {
    // Two identical transfers to the same recipient: the matcher refuses to
    // choose, which is exactly when the row needs its candidates surfaced.
    const a = makeTransfer(407, 777, 10000, 0);
    const b = makeTransfer(408, 777, 10000, 0);
    const p = { ...makePayment('p1', 10000, 777), worker_name: 'Loren Zagado' };
    const unmatched = [
      {
        payment_id: 'p1',
        worker_id: 'w1',
        outcome: 'ambiguous_exact' as const,
        reason: 'two equally close',
        candidate_transfer_ids: ['407', '408'],
      },
    ];

    annotateOrphans(unmatched, [p], [a, b], 7, new Map([['777', 'Loren Zagado']]));

    expect(unmatched[0]?.candidate_orphan_transfers?.map((c) => c.transfer_id)).toEqual([
      '407',
      '408',
    ]);
  });

  it('offers each period the transfer sent inside ITS legal window', () => {
    // A flat-rate contractor paid through a since-deleted recipient: every period
    // is the same amount to the same account, so the name hit fits them all and
    // amount can't order them. December's row must not lead with November's
    // transfer just because Wise listed it first.
    const oct = makeTransferOn(405, 777, 10000, '2024-10-30');
    const nov = makeTransferOn(406, 777, 10000, '2024-11-15');
    const mk = (id: string, periodEnd: string, payDate: string): MatcherPayment => ({
      ...makePayment(id, 10000, 888, { periodEnd, payDate, paidAt: `${periodEnd}T00:00:00Z` }),
      worker_name: 'Cecilia Pasaoa Velante',
    });
    const first = mk('p-oct1', '2024-10-15', '2024-10-31');
    const second = mk('p-oct16', '2024-10-31', '2024-11-15');
    const unmatched = [first, second].map((p) => ({
      payment_id: p.id,
      worker_id: `w-${p.id}`,
      outcome: 'no_wise_transfer' as const,
      reason: 'x',
      recipient_keys_tried: ['888'],
    }));

    annotateOrphans(
      unmatched,
      [first, second],
      [oct, nov],
      7,
      new Map([['777', 'Cecilia Velante']]),
    );

    expect(unmatched[0]?.candidate_orphan_transfers?.[0]?.transfer_id).toBe('405');
    expect(unmatched[1]?.candidate_orphan_transfers?.[0]?.transfer_id).toBe('406');
  });

  it('sweeps for a contractor with no recipient id at all', () => {
    const orphan = makeTransfer(403, 777, 10000, 0);
    const p: MatcherPayment = {
      ...makePayment('p1', 10000, 888),
      worker_name: 'Joyce Ann Millo',
      workers: null,
    };
    const unmatched = [
      {
        payment_id: 'p1',
        worker_id: 'w1',
        outcome: 'no_recipient' as const,
        reason: 'no recipient stored',
      },
    ];

    annotateOrphans(unmatched, [p], [orphan], 7, new Map([['777', 'Joyce Ann Millo']]));

    expect(unmatched[0]?.candidate_orphan_transfers?.[0]?.transfer_id).toBe('403');
  });

  it('never suggests a transfer whose amount disagrees', () => {
    const orphan = makeTransfer(404, 777, 12000, 0);
    const p = { ...makePayment('p1', 10000, 888), worker_name: 'Hazzan Buat' };
    const unmatched = [
      {
        payment_id: 'p1',
        worker_id: 'w1',
        outcome: 'no_wise_transfer' as const,
        reason: 'x',
        recipient_keys_tried: ['888'],
      },
    ];

    annotateOrphans(unmatched, [p], [orphan], 7, new Map([['777', 'Hazzan Buat']]));

    expect(unmatched[0]?.candidate_orphan_transfers).toBeUndefined();
  });

  it('no orphans when all transfers are claimed', () => {
    const t = makeTransfer(1, 999, 10000, 0);
    const unmatched = [
      {
        payment_id: 'p1',
        worker_id: 'w1',
        outcome: 'no_wise_transfer' as const,
        reason: 'x',
        recipient_keys_tried: ['999'],
      },
    ];
    // Claim t in allResults (it has transfer_id = '1').
    const allResults = [
      {
        payment_id: 'p2',
        worker_id: 'w2',
        outcome: 'matched_exact' as const,
        transfer_id: '1',
        amount: 10000,
        wise_status: 'outgoing_payment_sent',
        wise_dates: { created: null, dateFunded: null, dateSent: null },
      },
      ...unmatched,
    ];

    annotateOrphans(allResults, [makePayment('p1', 10000, 888)], [t], 7);

    const unmatchedResult = allResults.find((r) => r.payment_id === 'p1');
    expect(
      unmatchedResult && 'candidate_orphan_transfers' in unmatchedResult
        ? unmatchedResult.candidate_orphan_transfers
        : undefined,
    ).toBeUndefined();
  });
});
