/**
 * Needs-Attention queue — the pure half (no DB, no React).
 *
 * One exception CLASS = one row: label · count (+ ₱ where money is at stake) ·
 * age of the oldest item · the link that fixes it. Ranked severity-desc then
 * age-desc, so the oldest money problem is always the first thing read.
 *
 * Severity contract (docs/design/dashboard-redesign.md §8):
 *   critical — money is wrong or a deadline is at/past due
 *   warn     — blocks the pay run or a compliance obligation
 *   info     — routine work
 *
 * Classes carrying a `banner` also render as a top-of-page alert. Dedupe rule:
 * a worker counted in `missingRate` is never also counted as "needs setup"
 * somewhere else — each worker-level problem belongs to exactly one class.
 */

import { money } from '@/lib/format';

export type AttentionSeverity = 'critical' | 'warn' | 'info';

export interface AttentionItem {
  key: string;
  severity: AttentionSeverity;
  /** Decorative — always paired with text, never colour-alone (WCAG 1.4.1). */
  icon: string;
  label: string;
  count: number;
  /** Pre-formatted money at stake; omitted for classes that carry none. */
  amount?: string;
  /** Age of the oldest item in days; null when the class has no meaningful age. */
  oldestDays: number | null;
  /** Extra context, e.g. the worker names behind the count. */
  detail?: string;
  /** Verb for the row's link. */
  action: string;
  href: string;
  /** Full sentence for the top-of-page banner. Only money/deadline classes get one. */
  banner?: string;
}

export interface AttentionWorker {
  id: string;
  name: string;
}

export interface AttentionInput {
  periodStart: string;
  isOwner: boolean;
  canCountersign: boolean;
  /** Owner-only: Wise rows holding a transfer id Wise never confirmed as paid. */
  unconfirmedWise: { count: number; php: number };
  failedPayouts: { count: number; periodId: string | null };
  /** The nearest locked period whose pay date is within reach, if any. */
  payDate: { periodId: string; payDate: string; daysLeft: number; unpaid: number } | null;
  pendingTime: { count: number; oldestDays: number | null };
  unattributedTime: number;
  docsOverdue: number;
  docsExpiring: number;
  docsPendingReview: { count: number; oldestDays: number | null };
  deferredOverdue: number;
  onboardingStalled: number;
  sessionsPending: { count: number; oldestDays: number | null };
  countersignPending: number;
  missingRate: AttentionWorker[];
  missingPayoutMethod: AttentionWorker[];
  coverageGaps: number;
}

const RANK: Record<AttentionSeverity, number> = { critical: 0, warn: 1, info: 2 };

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

/** `/contractors/<id>` when a single worker is behind the count, else the list. */
const workerHref = (workers: AttentionWorker[]): string =>
  workers.length === 1 && workers[0] ? `/contractors/${workers[0].id}` : '/contractors';

const names = (workers: AttentionWorker[]): string =>
  workers
    .slice(0, 3)
    .map((w) => w.name)
    .join(', ') + (workers.length > 3 ? ` +${workers.length - 3} more` : '');

/** Days-to-pay-date as an English phrase — the deadline, never inferred from paid_at. */
export const payDatePhrase = (daysLeft: number): string => {
  if (daysLeft < 0) return `${Math.abs(daysLeft)} ${plural(Math.abs(daysLeft), 'day')} overdue`;
  if (daysLeft === 0) return 'today';
  if (daysLeft === 1) return 'tomorrow';
  return `in ${daysLeft} days`;
};

export const buildAttentionItems = (i: AttentionInput): AttentionItem[] => {
  const items: AttentionItem[] = [];

  // --- critical: money is wrong, or a deadline is at hand -------------------
  if (i.isOwner && i.unconfirmedWise.count > 0) {
    const amount = money(i.unconfirmedWise.php, 'PHP');
    items.push({
      key: 'wise_unconfirmed',
      severity: 'critical',
      icon: '⛔',
      label: 'Wise links unconfirmed',
      count: i.unconfirmedWise.count,
      amount,
      oldestDays: null,
      action: 'Reconcile',
      href: '/batches',
      banner: `${i.unconfirmedWise.count} Wise ${plural(i.unconfirmedWise.count, 'link')} unconfirmed — ${amount} may never have left. Counts app-linked transfers only; run Poll in Batches for Wise-side truth.`,
    });
  }

  if (i.failedPayouts.count > 0) {
    items.push({
      key: 'failed_payouts',
      severity: 'critical',
      icon: '🚩',
      label: 'Failed payouts',
      count: i.failedPayouts.count,
      oldestDays: null,
      action: 'Re-stage',
      href: i.failedPayouts.periodId ? `/process?period=${i.failedPayouts.periodId}` : '/process',
      banner: `${i.failedPayouts.count} ${plural(i.failedPayouts.count, 'payout')} failed — ${plural(i.failedPayouts.count, 'a contractor has', 'contractors have')} not been paid.`,
    });
  }

  if (i.payDate && i.payDate.unpaid > 0) {
    const { daysLeft, unpaid, payDate, periodId } = i.payDate;
    const severity: AttentionSeverity = daysLeft <= 1 ? 'critical' : 'warn';
    items.push({
      key: 'pay_date',
      severity,
      icon: daysLeft <= 1 ? '⛔' : '⚠',
      label: 'Pay day',
      count: unpaid,
      oldestDays: daysLeft < 0 ? Math.abs(daysLeft) : null,
      detail: payDatePhrase(daysLeft),
      action: 'Send',
      href: `/process?period=${periodId}`,
      banner: `Pay day ${payDate} is ${payDatePhrase(daysLeft)} — ${unpaid} ${plural(unpaid, 'payment')} not sent.`,
    });
  }

  // --- warn: blocks the run or a compliance obligation ----------------------
  if (i.missingRate.length > 0) {
    items.push({
      key: 'no_rate',
      severity: 'warn',
      icon: '⚠',
      label: 'No effective rate',
      count: i.missingRate.length,
      oldestDays: null,
      detail: names(i.missingRate),
      action: 'Add rate',
      href: workerHref(i.missingRate),
    });
  }

  if (i.missingPayoutMethod.length > 0) {
    items.push({
      key: 'no_payout_method',
      severity: 'warn',
      icon: '⚠',
      label: 'No payout method',
      count: i.missingPayoutMethod.length,
      oldestDays: null,
      detail: names(i.missingPayoutMethod),
      action: 'Set method',
      href: workerHref(i.missingPayoutMethod),
    });
  }

  if (i.unattributedTime > 0) {
    items.push({
      key: 'unattributed_time',
      severity: 'warn',
      icon: '⚠',
      label: 'Unattributed time',
      count: i.unattributedTime,
      oldestDays: null,
      detail: 'tracked hours matched to nobody',
      action: 'Match',
      href: `/time?start=${i.periodStart}`,
    });
  }

  if (i.docsOverdue > 0) {
    items.push({
      key: 'docs_overdue',
      severity: 'warn',
      icon: '⚠',
      label: 'Documents expired',
      count: i.docsOverdue,
      oldestDays: null,
      action: 'Review',
      href: '/documents',
    });
  }

  if (i.deferredOverdue > 0) {
    items.push({
      key: 'deferred_overdue',
      severity: 'warn',
      icon: '⚠',
      label: 'Follow-ups overdue',
      count: i.deferredOverdue,
      oldestDays: null,
      detail: 'deferred documents past their date',
      action: 'Chase',
      href: '/onboarding',
    });
  }

  if (i.onboardingStalled > 0) {
    items.push({
      key: 'onboarding_stalled',
      severity: 'warn',
      icon: '⚠',
      label: 'Onboarding stalled',
      count: i.onboardingStalled,
      oldestDays: null,
      action: 'Open',
      href: '/onboarding',
    });
  }

  // --- info: routine work --------------------------------------------------
  if (i.pendingTime.count > 0) {
    items.push({
      key: 'time_pending',
      severity: i.pendingTime.oldestDays != null && i.pendingTime.oldestDays > 7 ? 'warn' : 'info',
      icon: i.pendingTime.oldestDays != null && i.pendingTime.oldestDays > 7 ? '⚠' : 'ⓘ',
      label: 'Time pending approval',
      count: i.pendingTime.count,
      oldestDays: i.pendingTime.oldestDays,
      action: 'Approve',
      href: `/time?start=${i.periodStart}`,
    });
  }

  if (i.docsPendingReview.count > 0) {
    items.push({
      key: 'docs_review',
      severity: 'info',
      icon: 'ⓘ',
      label: 'Documents to review',
      count: i.docsPendingReview.count,
      oldestDays: i.docsPendingReview.oldestDays,
      action: 'Review',
      href: '/documents',
    });
  }

  if (i.docsExpiring > 0) {
    items.push({
      key: 'docs_expiring',
      severity: 'info',
      icon: 'ⓘ',
      label: 'Documents expiring soon',
      count: i.docsExpiring,
      oldestDays: null,
      detail: 'within 30 days',
      action: 'Review',
      href: '/documents',
    });
  }

  if (i.sessionsPending.count > 0) {
    items.push({
      key: 'sessions_pending',
      severity: 'info',
      icon: 'ⓘ',
      label: 'Sessions pending approval',
      count: i.sessionsPending.count,
      oldestDays: i.sessionsPending.oldestDays,
      action: 'Approve',
      href: '/sessions',
    });
  }

  if (i.canCountersign && i.countersignPending > 0) {
    items.push({
      key: 'countersign',
      severity: 'info',
      icon: '✍',
      label: 'Awaiting your countersignature',
      count: i.countersignPending,
      oldestDays: null,
      action: 'Countersign',
      href: '/onboarding',
    });
  }

  if (i.coverageGaps > 0) {
    items.push({
      key: 'coverage_gaps',
      severity: 'info',
      icon: 'ⓘ',
      label: 'Under expected hours',
      count: i.coverageGaps,
      oldestDays: null,
      action: 'Investigate',
      href: '/coverage',
    });
  }

  return items.sort(
    (a, b) =>
      RANK[a.severity] - RANK[b.severity] ||
      (b.oldestDays ?? -1) - (a.oldestDays ?? -1) ||
      b.count - a.count,
  );
};

/** The subset that also earns a top-of-page banner. */
export const bannerItems = (items: AttentionItem[]): AttentionItem[] =>
  items.filter((it) => it.banner != null);
