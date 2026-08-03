import { describe, expect, it } from 'vitest';
import {
  type AttentionInput,
  bannerItems,
  buildAttentionItems,
  payDatePhrase,
} from '@/lib/overview/attention';

/** Nothing wrong anywhere — every class opts out. */
const clean = (over: Partial<AttentionInput> = {}): AttentionInput => ({
  periodStart: '2026-07-16',
  isOwner: true,
  canCountersign: false,
  unconfirmedWise: { count: 0, php: 0 },
  failedPayouts: { count: 0, periodId: null },
  payDate: null,
  pendingTime: { count: 0, oldestDays: null },
  unattributedTime: 0,
  docsOverdue: 0,
  docsExpiring: 0,
  docsPendingReview: { count: 0, oldestDays: null },
  deferredOverdue: 0,
  onboardingStalled: 0,
  sessionsPending: { count: 0, oldestDays: null },
  countersignPending: 0,
  missingRate: [],
  missingPayoutMethod: [],
  coverageGaps: 0,
  ...over,
});

const keys = (input: AttentionInput): string[] => buildAttentionItems(input).map((i) => i.key);

describe('buildAttentionItems', () => {
  it('renders nothing when every class is clear', () => {
    expect(buildAttentionItems(clean())).toEqual([]);
  });

  it('surfaces unconfirmed Wise links to the owner only', () => {
    const input = clean({ unconfirmedWise: { count: 3, php: 58_200 } });
    const owner = buildAttentionItems(input)[0];
    expect(owner?.key).toBe('wise_unconfirmed');
    expect(owner?.severity).toBe('critical');
    expect(owner?.amount).toBe('PHP 58,200.00');
    expect(owner?.href).toBe('/batches');
    // A scoped admin cannot act on these (requireOwner gates Wise staging), so
    // the class must not appear in their page at all.
    expect(keys({ ...input, isOwner: false })).not.toContain('wise_unconfirmed');
  });

  it('ranks severity first, then age', () => {
    const ranked = buildAttentionItems(
      clean({
        docsPendingReview: { count: 4, oldestDays: 2 },
        pendingTime: { count: 41, oldestDays: 9 },
        docsOverdue: 2,
        failedPayouts: { count: 1, periodId: 'p1' },
      }),
    );
    // critical first; then the two warns (pending time is >7d so it escalates,
    // and 9d beats the ageless doc row); the info row last.
    expect(ranked.map((r) => r.key)).toEqual([
      'failed_payouts',
      'time_pending',
      'docs_overdue',
      'docs_review',
    ]);
  });

  it('escalates a stale approval backlog from info to warn', () => {
    const fresh = buildAttentionItems(clean({ pendingTime: { count: 41, oldestDays: 3 } }))[0];
    const stale = buildAttentionItems(clean({ pendingTime: { count: 41, oldestDays: 12 } }))[0];
    expect(fresh?.severity).toBe('info');
    expect(stale?.severity).toBe('warn');
    expect(stale?.oldestDays).toBe(12);
  });

  it('treats a breached pay date as critical and a 3-day runway as warn', () => {
    const near = buildAttentionItems(
      clean({ payDate: { periodId: 'u1', payDate: '2026-07-31', daysLeft: 3, unpaid: 24 } }),
    )[0];
    const breached = buildAttentionItems(
      clean({ payDate: { periodId: 'u1', payDate: '2026-07-31', daysLeft: -2, unpaid: 24 } }),
    )[0];
    expect(near?.severity).toBe('warn');
    expect(breached?.severity).toBe('critical');
    expect(breached?.banner).toContain('2 days overdue');
    // /process deep-links take the period UUID, never the ISO start date.
    expect(breached?.href).toBe('/process?period=u1');
  });

  it('does not raise a pay-date row when every payment is already sent', () => {
    expect(
      keys(clean({ payDate: { periodId: 'u1', payDate: '2026-07-31', daysLeft: 0, unpaid: 0 } })),
    ).toEqual([]);
  });

  it('links a single named worker to their own page, several to the list', () => {
    const one = buildAttentionItems(clean({ missingRate: [{ id: 'w1', name: 'D. Reyes' }] }))[0];
    expect(one?.href).toBe('/contractors/w1');
    expect(one?.detail).toBe('D. Reyes');
    const many = buildAttentionItems(
      clean({
        missingRate: [
          { id: 'w1', name: 'A' },
          { id: 'w2', name: 'B' },
        ],
      }),
    )[0];
    expect(many?.href).toBe('/contractors');
  });

  it('hides the countersign queue from admins without the capability', () => {
    const input = clean({ countersignPending: 2 });
    expect(keys(input)).not.toContain('countersign');
    expect(keys({ ...input, canCountersign: true })).toContain('countersign');
  });

  it('banners only the money/deadline classes, not routine work', () => {
    const items = buildAttentionItems(
      clean({
        failedPayouts: { count: 1, periodId: 'p1' },
        docsPendingReview: { count: 4, oldestDays: 2 },
        coverageGaps: 3,
      }),
    );
    expect(bannerItems(items).map((i) => i.key)).toEqual(['failed_payouts']);
  });
});

describe('payDatePhrase', () => {
  it('reads forward, and names the breach when it is past', () => {
    expect(payDatePhrase(3)).toBe('in 3 days');
    expect(payDatePhrase(1)).toBe('tomorrow');
    expect(payDatePhrase(0)).toBe('today');
    expect(payDatePhrase(-1)).toBe('1 day overdue');
    expect(payDatePhrase(-5)).toBe('5 days overdue');
  });
});
