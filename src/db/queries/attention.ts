/**
 * Needs-Attention queue — the DB half (§8 of docs/design/dashboard-redesign.md).
 *
 * Every exception class the dashboard surfaces is counted here, in ONE parallel
 * batch of head-count queries (`count:'exact', head:true` transfers zero rows).
 * The ranking/labelling lives in `src/lib/overview/attention.ts` so it stays
 * pure and testable; this module only reads.
 *
 * The Wise predicate is imported from `src/lib/wise/reconcilable.ts` rather than
 * re-derived — a second copy of "which rows are ghosts" is how the first one
 * drifts.
 *
 * `cache()`-wrapped so the alerts band, the queue and the KPI tiles share a
 * single round-trip per request even though they render as separate streamed
 * blocks.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cache } from 'react';
import { fetchPeriodSummaries } from '@/db/queries/payroll';
import type { Database } from '@/db/types';
import type { AttentionWorker } from '@/lib/overview/attention';
import { isUnconfirmedWiseLink } from '@/lib/wise/reconcilable';

type Db = SupabaseClient<Database>;

/** Onboarding with no movement for this long counts as stalled. */
export const STALLED_DAYS = 14;
/** How far ahead a document expiry is called "expiring soon". */
export const EXPIRING_WITHIN_DAYS = 30;
/** Pay date this close (or past) escalates to the critical band. */
export const PAY_DATE_WARN_DAYS = 3;

export interface AttentionCounts {
  unconfirmedWise: { count: number; php: number };
  failedPayouts: { count: number; periodId: string | null };
  payDate: { periodId: string; payDate: string; daysLeft: number; unpaid: number } | null;
  pendingTime: { count: number; oldestDays: number | null };
  unattributedTime: number;
  docsOverdue: number;
  docsExpiring: number;
  docsPendingReview: { count: number; oldestDays: number | null };
  deferredOverdue: number;
  onboardingOpen: number;
  onboardingStalled: number;
  sessionsPending: { count: number; oldestDays: number | null };
  countersignPending: number;
  /** Locked periods whose money has not been sent — the liability KPI. */
  lockedUnpaid: { count: number; centavos: number };
  /** The locked batch to send first (earliest pay date), for the owner duty list. */
  lockedPeriod: { id: string; start: string; end: string } | null;
  /** Owner-only: open USD receivables. */
  arOutstandingUsd: number;
}

const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round(
    (new Date(`${toIso.slice(0, 10)}T00:00:00Z`).getTime() -
      new Date(`${fromIso.slice(0, 10)}T00:00:00Z`).getTime()) /
      86_400_000,
  );

const addDays = (iso: string, n: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/**
 * All §8 exception counts for a company, as of `today` (ISO date).
 * Owner-only classes are skipped entirely when `isOwner` is false — the data is
 * never fetched, so it cannot leak into the rendered payload (§12).
 */
export const fetchAttentionCounts = cache(
  async (
    db: Db,
    companyId: string,
    today: string,
    isOwner: boolean,
    canCountersign: boolean,
  ): Promise<AttentionCounts> => {
    const expiringBy = addDays(today, EXPIRING_WITHIN_DAYS);
    const stalledBefore = addDays(today, -STALLED_DAYS);

    const [
      wiseRows,
      failedRows,
      pendingTimeCount,
      pendingTimeOldest,
      unattributed,
      docsOverdue,
      docsExpiring,
      docsPendingCount,
      docsPendingOldest,
      deferredOverdue,
      onboarding,
      sessionsCount,
      sessionsOldest,
      summaries,
      countersign,
      invoices,
    ] = await Promise.all([
      // Ghost/unfunded Wise drafts — owner-only (fixing one needs Wise access).
      isOwner
        ? db
            .from('payments')
            .select('net_php, payout_method, wise_transfer_id, wise_locked_at, status')
            .eq('company_id', companyId)
            .eq('payout_method', 'wise')
            .not('wise_transfer_id', 'is', null)
            .is('wise_locked_at', null)
            .limit(2000)
        : null,
      db
        .from('payments')
        .select('pay_period_id')
        .eq('company_id', companyId)
        .eq('status', 'failed')
        .limit(500),
      db
        .from('time_entries')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('approval', 'pending'),
      db
        .from('time_entries')
        .select('work_date')
        .eq('company_id', companyId)
        .eq('approval', 'pending')
        .order('work_date', { ascending: true })
        .limit(1)
        .maybeSingle(),
      db
        .from('time_entries')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .is('worker_id', null),
      // Expiry classes mirror the digest predicate exactly (documents.ts:242):
      // a fileless placeholder reuses expires_on as a due date and must not
      // count as an expiring document.
      db
        .from('documents')
        .select('id, workers!inner(status)', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .not('storage_path', 'is', null)
        .eq('workers.status', 'active')
        .lt('expires_on', today),
      db
        .from('documents')
        .select('id, workers!inner(status)', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .not('storage_path', 'is', null)
        .eq('workers.status', 'active')
        .gte('expires_on', today)
        .lte('expires_on', expiringBy),
      db
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('review_status', 'pending'),
      db
        .from('documents')
        .select('created_at')
        .eq('company_id', companyId)
        .eq('review_status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      // ponytail: deliberately NOT company-filtered — deferred hiring docs carry
      // a NULL company_id (see fetchOnboardingFollowups), so a company filter
      // would always return 0. RLS is the scope here.
      db
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .eq('review_status', 'deferred')
        .lt('defer_until', today),
      db
        .from('onboarding_progress')
        .select(
          'completed_at, stalled, updated_at, workers!inner(status, worker_companies!inner(company_id))',
        )
        .eq('workers.worker_companies.company_id', companyId)
        .is('completed_at', null),
      db
        .from('service_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('approval', 'pending'),
      db
        .from('service_sessions')
        .select('session_date')
        .eq('company_id', companyId)
        .eq('approval', 'pending')
        .order('session_date', { ascending: true })
        .limit(1)
        .maybeSingle(),
      fetchPeriodSummaries(db, companyId),
      canCountersign
        ? Promise.all([
            db
              .from('onboarding_signatures')
              .select('worker_id, agreement_kind')
              .eq('status', 'signed'),
            db.from('onboarding_agreements').select('worker_id, agreement_kind, countersigned_at'),
            // Contract versions signed by the contractor, waiting on an admin (plan §7).
            db
              .from('contract_versions')
              .select('id', { count: 'exact', head: true })
              .eq('company_id', companyId)
              .eq('status', 'signed'),
          ])
        : null,
      isOwner
        ? db.from('invoices').select('total_usd, amount_received_usd').eq('status', 'sent')
        : null,
    ]);

    // Unconfirmed Wise links — sum in integer centavos.
    let wiseCount = 0;
    let wiseCentavos = 0;
    for (const row of wiseRows?.data ?? []) {
      if (!isUnconfirmedWiseLink(row)) continue;
      wiseCount += 1;
      wiseCentavos += Math.round(Number(row.net_php ?? 0) * 100);
    }

    const failed = failedRows.data ?? [];

    // Locked-but-unsent liability, and the nearest pay-date deadline.
    const locked = summaries.filter((p) => p.state === 'locked');
    const lockedUnpaid = {
      count: locked.length,
      centavos: locked.reduce((s, p) => s + p.totalNetCentavos, 0),
    };

    const byPayDate = [...locked].sort((a, b) =>
      String(a.payDate ?? '9999').localeCompare(String(b.payDate ?? '9999')),
    );
    const nextLocked = byPayDate[0];
    const atRisk = byPayDate.find(
      (p) => p.payDate != null && daysBetween(today, p.payDate) <= PAY_DATE_WARN_DAYS,
    );

    let payDate: AttentionCounts['payDate'] = null;
    if (atRisk?.payDate) {
      const { count } = await db
        .from('payments')
        .select('id', { count: 'exact', head: true })
        .eq('pay_period_id', atRisk.id)
        .in('status', ['draft', 'queued', 'failed']);
      payDate = {
        periodId: atRisk.id,
        payDate: atRisk.payDate,
        daysLeft: daysBetween(today, atRisk.payDate),
        unpaid: count ?? 0,
      };
    }

    // Onboarding: open = not completed; stalled = flagged, or untouched for
    // STALLED_DAYS, on an active worker.
    const onbRows = (onboarding.data ?? []).filter(
      (r) => (r.workers as { status?: string } | null)?.status === 'active',
    );
    const onboardingStalled = onbRows.filter(
      (r) => r.stalled || (r.updated_at ?? '').slice(0, 10) < stalledBefore,
    ).length;

    // Countersign: a signed agreement with no countersignature on its (worker,
    // kind) pair. Names/kinds only — never signature payloads or IPs (§12 PHI).
    let countersignPending = 0;
    if (countersign) {
      const [sigRes, agrRes, versionsRes] = countersign;
      const signedOff = new Set(
        (agrRes.data ?? [])
          .filter((a) => a.countersigned_at != null)
          .map((a) => `${a.worker_id}:${a.agreement_kind}`),
      );
      countersignPending =
        (sigRes.data ?? []).filter((s) => !signedOff.has(`${s.worker_id}:${s.agreement_kind}`))
          .length + (versionsRes.count ?? 0);
    }

    const arOutstandingUsd = (invoices?.data ?? []).reduce(
      (s, inv) => s + (Number(inv.total_usd ?? 0) - Number(inv.amount_received_usd ?? 0)),
      0,
    );

    return {
      unconfirmedWise: { count: wiseCount, php: wiseCentavos / 100 },
      failedPayouts: { count: failed.length, periodId: failed[0]?.pay_period_id ?? null },
      payDate,
      pendingTime: {
        count: pendingTimeCount.count ?? 0,
        oldestDays: pendingTimeOldest.data?.work_date
          ? daysBetween(pendingTimeOldest.data.work_date, today)
          : null,
      },
      unattributedTime: unattributed.count ?? 0,
      docsOverdue: docsOverdue.count ?? 0,
      docsExpiring: docsExpiring.count ?? 0,
      docsPendingReview: {
        count: docsPendingCount.count ?? 0,
        oldestDays: docsPendingOldest.data?.created_at
          ? daysBetween(docsPendingOldest.data.created_at, today)
          : null,
      },
      deferredOverdue: deferredOverdue.count ?? 0,
      onboardingOpen: onbRows.length,
      onboardingStalled,
      sessionsPending: {
        count: sessionsCount.count ?? 0,
        oldestDays: sessionsOldest.data?.session_date
          ? daysBetween(sessionsOldest.data.session_date, today)
          : null,
      },
      countersignPending,
      lockedUnpaid,
      lockedPeriod: nextLocked
        ? { id: nextLocked.id, start: nextLocked.periodStart, end: nextLocked.periodEnd }
        : null,
      arOutstandingUsd,
    };
  },
);

/** Workers behind the existing `getAlerts` kinds, split per class for the queue. */
export const splitAlertWorkers = (
  alerts: { kind: 'no_rate' | 'no_payout_method'; workerId: string; workerName: string }[],
): { missingRate: AttentionWorker[]; missingPayoutMethod: AttentionWorker[] } => {
  const uniq = (kind: string): AttentionWorker[] => {
    const seen = new Map<string, AttentionWorker>();
    for (const a of alerts) {
      if (a.kind !== kind) continue;
      seen.set(a.workerId, { id: a.workerId, name: a.workerName });
    }
    return [...seen.values()];
  };
  return { missingRate: uniq('no_rate'), missingPayoutMethod: uniq('no_payout_method') };
};
