import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { ActivityTail } from '@/components/overview/ActivityTail';
import { AlertsBanner } from '@/components/overview/AlertsBanner';
import { AsOfStamp } from '@/components/overview/AsOfStamp';
import { buildDuties, MyWorkCard } from '@/components/overview/MyWorkCard';
import { NeedsAttentionQueue } from '@/components/overview/NeedsAttentionQueue';
import { NetSparkline } from '@/components/overview/NetSparkline';
import { PipelineStrip } from '@/components/overview/PipelineStrip';
import { RefreshButton } from '@/components/overview/RefreshButton';
import { StatTile } from '@/components/overview/StatTile';
import { createServerSupabase } from '@/db/clients/server';
import { fetchAttentionCounts, splitAlertWorkers } from '@/db/queries/attention';
import { getAuditLogPage } from '@/db/queries/audit';
import { getCoverageGaps } from '@/db/queries/coverage';
import {
  countActiveContractors,
  getAlerts,
  getPeriodNetTotal,
  getPipelineData,
  getRecentPeriodNets,
} from '@/db/queries/overview';
import { previousPeriod } from '@/lib/dates/periods';
import { centavosToPhp, fmtDate, money } from '@/lib/format';
import { bannerItems, buildAttentionItems } from '@/lib/overview/attention';
import { type CurrentAdmin, getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId, listCompanies } from '@/server/company';

export const metadata = { title: 'Overview — Aaron Anderson E.H.S. LLC' };

/** Human label for a pay-period state — mirrors the legacy `stLabel`. */
const stateLabel = (state: string | null): string => {
  switch (state) {
    case 'paid':
      return 'Paid';
    case 'locked':
      return 'Locked — awaiting payout';
    case 'open':
      return 'Open (draft)';
    default:
      return state ?? 'Not started';
  }
};

/**
 * Pay-day status phrase — port of the legacy `payday` derivation. Forward-looking
 * only: `pay_date` is the DEADLINE, and payment is manual and usually early, so
 * nothing here is ever inferred from `paid_at`.
 */
const paydayPhrase = (state: string | null, payDate: string, today: string): string | null => {
  if (!payDate) return null;
  if (state === 'paid') return 'paid';
  const dd = Math.round(
    (new Date(`${payDate}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) /
      86_400_000,
  );
  if (dd > 1) return `pay day in ${dd} days`;
  if (dd === 1) return 'pay day tomorrow';
  if (dd === 0) return 'pay day today';
  if (dd === -1) return 'pay day was yesterday';
  return `pay day ${Math.abs(dd)} days ago`;
};

/**
 * Per-block failure. One dead query used to take the whole page down with it
 * (everything hung off a single Promise.all); now each block renders its own
 * "couldn't load" while every other block still shows real data.
 */
const BlockError = ({ title }: { title: string }) => (
  <section className="card">
    <h2>{title}</h2>
    <div className="banner error" style={{ marginBottom: 0 }}>
      <span>Couldn&apos;t load this section — press Refresh to try again.</span>
    </div>
  </section>
);

/** Fixed-height placeholder: the streamed block lands in exactly this box (CLS). */
const BlockSkeleton = ({ height, bars = 3 }: { height: number; bars?: number }) => (
  <div className="card" style={{ minHeight: height }} aria-hidden="true">
    <div className="skel">
      {Array.from({ length: bars }, (_, i) => `${100 - i * 12}%`).map((width, i) => (
        <div key={width} className="skel-bar" style={{ width, height: i === 0 ? 18 : 14 }} />
      ))}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// B2 + B3 + B4 — the exception band, the queue, and role-exclusive duties.
// One fetch feeds all three; they render together because they share it.
// ---------------------------------------------------------------------------

interface BlockProps {
  admin: CurrentAdmin;
  companyId: string;
  today: string;
  period: { start: string; end: string; payDate: string };
}

const ExceptionsBlock = async ({ admin, companyId, today, period }: BlockProps) => {
  try {
    const db = await createServerSupabase();
    const [counts, alerts, coverage] = await Promise.all([
      fetchAttentionCounts(db, companyId, today, admin.isOwner, admin.canCountersign),
      getAlerts(db, companyId, period.start, period.end),
      getCoverageGaps(db, companyId, period.start, period.end),
    ]);

    const { missingRate, missingPayoutMethod } = splitAlertWorkers(alerts);
    const items = buildAttentionItems({
      periodStart: period.start,
      isOwner: admin.isOwner,
      canCountersign: admin.canCountersign,
      unconfirmedWise: counts.unconfirmedWise,
      failedPayouts: counts.failedPayouts,
      payDate: counts.payDate,
      pendingTime: counts.pendingTime,
      unattributedTime: counts.unattributedTime,
      docsOverdue: counts.docsOverdue,
      docsExpiring: counts.docsExpiring,
      docsPendingReview: counts.docsPendingReview,
      deferredOverdue: counts.deferredOverdue,
      onboardingStalled: counts.onboardingStalled,
      sessionsPending: counts.sessionsPending,
      countersignPending: counts.countersignPending,
      missingRate,
      missingPayoutMethod,
      coverageGaps: coverage.gaps.length,
    });

    const duties = buildDuties({
      isOwner: admin.isOwner,
      canCountersign: admin.canCountersign,
      lockedUnpaid: counts.lockedUnpaid,
      unconfirmedWise: counts.unconfirmedWise,
      countersignPending: counts.countersignPending,
      lockedPeriod: counts.lockedPeriod,
    });

    return (
      <>
        <AlertsBanner items={bannerItems(items)} />
        <div className="ov-cols">
          <NeedsAttentionQueue items={items} />
          <MyWorkCard duties={duties} isOwner={admin.isOwner} />
        </div>
      </>
    );
  } catch {
    return <BlockError title="Needs attention" />;
  }
};

// ---------------------------------------------------------------------------
// B5 — the cycle: pipeline (complete-not-any), net, and the exception KPIs.
// ---------------------------------------------------------------------------

const CycleBlock = async ({ admin, companyId, today, period }: BlockProps) => {
  try {
    const db = await createServerSupabase();
    const [pipeline, netTotal, activeContractors, counts, coverage] = await Promise.all([
      getPipelineData(db, companyId, period.start, period.end),
      getPeriodNetTotal(db, companyId, period.start, period.end),
      countActiveContractors(db, companyId),
      fetchAttentionCounts(db, companyId, today, admin.isOwner, admin.canCountersign),
      getCoverageGaps(db, companyId, period.start, period.end),
    ]);

    // No payments yet is NOT ₱0.00 — say it hasn't been calculated (#029).
    const netCentavos = netTotal != null ? Math.round(netTotal * 100) : null;
    const netDisplay =
      netCentavos != null ? money(centavosToPhp(netCentavos), 'PHP') : 'Not calculated yet';

    const payday = paydayPhrase(pipeline.periodState, period.payDate, today);
    const lockedHref = counts.lockedPeriod
      ? `/process?period=${counts.lockedPeriod.id}`
      : '/payroll';
    const backlogAge = counts.pendingTime.oldestDays;

    return (
      <>
        <section className="card ov-cycle" aria-labelledby="ov-cycle-h">
          <div className="ov-cycle-head">
            <div>
              <div className="ov-tile-label" style={{ marginBottom: 4 }}>
                <span aria-hidden="true">📅</span>THIS PAY CYCLE
              </div>
              <h2 id="ov-cycle-h" style={{ fontSize: 17 }}>
                {fmtDate(period.start)} → {fmtDate(period.end)}
              </h2>
              <div className="ov-cycle-meta">
                <span className={`pill ${pipeline.periodState === 'paid' ? 'good' : 'warn'}`}>
                  {stateLabel(pipeline.periodState)}
                </span>
                {payday != null && <span className="ov-cycle-dot">{payday}</span>}
                <span className="ov-cycle-dot">{activeContractors} active contractors</span>
              </div>
            </div>
            <Link className="ov-cycle-net" href={`/payroll?period=${period.start}`}>
              <span className="ov-tile-label" style={{ justifyContent: 'flex-end' }}>
                Net this cycle
              </span>
              <span
                className="ov-tile-num"
                style={netCentavos == null ? { fontSize: 16, color: 'var(--muted)' } : undefined}
              >
                {netDisplay}
              </span>
            </Link>
          </div>
          <PipelineStrip periodStart={period.start} periodEnd={period.end} pipeline={pipeline} />
        </section>

        <div className="ov-grid" style={{ marginBottom: 16 }}>
          <StatTile
            icon="💸"
            label="Locked, not yet sent"
            value={
              counts.lockedUnpaid.count > 0
                ? money(centavosToPhp(counts.lockedUnpaid.centavos), 'PHP')
                : '₱0.00'
            }
            sub={
              counts.lockedUnpaid.count > 0
                ? `${counts.lockedUnpaid.count} locked batch${counts.lockedUnpaid.count === 1 ? '' : 'es'} awaiting payout`
                : 'All locked pay is sent'
            }
            tone={counts.lockedUnpaid.count > 0 ? 'warn' : 'good'}
            href={lockedHref}
          />
          <StatTile
            icon="⏱"
            label="Time pending approval"
            value={counts.pendingTime.count}
            sub={
              counts.pendingTime.count > 0
                ? `oldest ${backlogAge ?? 0} day${backlogAge === 1 ? '' : 's'} old`
                : 'All time approved'
            }
            tone={
              counts.pendingTime.count === 0
                ? 'good'
                : backlogAge != null && backlogAge > 7
                  ? 'warn'
                  : 'info'
            }
            href={`/time?start=${period.start}`}
          />
          <StatTile
            icon="📄"
            label="Documents expired"
            value={counts.docsOverdue}
            sub={
              counts.docsOverdue > 0 || counts.docsExpiring > 0
                ? `${counts.docsExpiring} expiring within 30 days`
                : 'Nothing expired or expiring'
            }
            tone={counts.docsOverdue > 0 ? 'warn' : counts.docsExpiring > 0 ? 'info' : 'good'}
            href="/documents"
          />
          {admin.isOwner ? (
            <StatTile
              icon="🧾"
              label="AR outstanding"
              value={money(counts.arOutstandingUsd, 'USD')}
              sub={
                counts.arOutstandingUsd > 0 ? 'on invoices marked sent' : 'No open client invoices'
              }
              tone={counts.arOutstandingUsd > 0 ? 'info' : 'good'}
              href="/invoicing"
            />
          ) : (
            <StatTile
              icon="👤"
              label="Onboarding open"
              value={counts.onboardingOpen}
              sub={
                counts.onboardingStalled > 0
                  ? `${counts.onboardingStalled} stalled`
                  : 'None stalled'
              }
              tone={
                counts.onboardingStalled > 0 ? 'warn' : counts.onboardingOpen > 0 ? 'info' : 'good'
              }
              href="/onboarding"
            />
          )}
          <StatTile
            icon="📉"
            label="Coverage gaps"
            value={coverage.measured === 0 ? '—' : coverage.gaps.length}
            sub={
              coverage.measured === 0
                ? 'No coverage targets set'
                : coverage.gaps.length > 0
                  ? 'contractors under expected hours'
                  : `All ${coverage.measured} on track`
            }
            tone={coverage.gaps.length > 0 ? 'warn' : coverage.measured === 0 ? 'neutral' : 'good'}
            href="/coverage"
          />
        </div>
      </>
    );
  } catch {
    return <BlockError title="This pay cycle" />;
  }
};

// ---------------------------------------------------------------------------
// B6 — the one earned trend. B7 — what just changed.
// ---------------------------------------------------------------------------

const TrendBlock = async ({ companyId }: { companyId: string }) => {
  try {
    const db = await createServerSupabase();
    const recentNets = await getRecentPeriodNets(db, companyId, 6);

    // Delta from the series already fetched — no extra query.
    const last = recentNets.at(-1);
    const prior = recentNets.at(-2);
    const lastC = last ? Math.round(last.totalNetPhp * 100) : null;
    const priorC = prior ? Math.round(prior.totalNetPhp * 100) : null;
    const deltaPct =
      lastC != null && priorC != null && priorC !== 0 ? ((lastC - priorC) / priorC) * 100 : null;

    return (
      <Link className="card ov-trend" href="/reports">
        <NetSparkline periods={recentNets} deltaPct={deltaPct} />
      </Link>
    );
  } catch {
    return <BlockError title="Net trend" />;
  }
};

const ActivityBlock = async ({ companyId }: { companyId: string }) => {
  try {
    const db = await createServerSupabase();
    const { rows } = await getAuditLogPage(db, companyId, { page: 1, pageSize: 8 });
    return <ActivityTail rows={rows} />;
  } catch {
    return <BlockError title="Recent activity" />;
  }
};

// ---------------------------------------------------------------------------

export default async function OverviewPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Overview</h2>
        <p className="sub">No company selected or accessible. Please contact the owner.</p>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  // Arrears: the pay cycle being worked (calc → lock → pay) is the PREVIOUS
  // half-month, not the one containing today. periodFor(today) has no payroll
  // row while it accrues, so its net/pipeline/state never move and the pay-day
  // countdown ("today"/"tomorrow") is unreachable (its pay date is always
  // ≥15 days out). Same fix as the /payroll default.
  const period = previousPeriod(today);

  // B1 is the LCP element and must not wait on a query: company names are
  // request-cached (the shell already read them) and the period is pure date
  // maths, so the header text is in the first flush while every block below
  // streams in behind its own skeleton.
  const companies = await listCompanies();
  const companyName = companies.find((c) => c.id === companyId)?.name ?? 'This company';
  const blockProps = { admin, companyId, today, period };

  return (
    <div className="ov-page">
      <header className="card ov-header">
        <div>
          <h1 className="ov-title">Overview</h1>
          <p className="sub" style={{ margin: 0 }}>
            {companyName}
          </p>
        </div>
        <div className="ov-header-side">
          <Link className="ov-chip" href={`/payroll?period=${period.start}`}>
            <span aria-hidden="true">📅</span>
            {fmtDate(period.start)} – {fmtDate(period.end)}
            <span className="ov-chip-go" aria-hidden="true">
              →
            </span>
          </Link>
          <div className="ov-header-refresh">
            <RefreshButton />
            <AsOfStamp />
          </div>
        </div>
      </header>

      <Suspense fallback={<BlockSkeleton height={280} bars={5} />}>
        <ExceptionsBlock {...blockProps} />
      </Suspense>

      <Suspense fallback={<BlockSkeleton height={200} bars={4} />}>
        <CycleBlock {...blockProps} />
      </Suspense>

      <div className="ov-cols narrow">
        <Suspense fallback={<BlockSkeleton height={120} bars={2} />}>
          <TrendBlock companyId={companyId} />
        </Suspense>
        <Suspense fallback={<BlockSkeleton height={120} bars={3} />}>
          <ActivityBlock companyId={companyId} />
        </Suspense>
      </div>
    </div>
  );
}
