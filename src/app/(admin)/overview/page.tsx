import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AlertsBanner } from '@/components/overview/AlertsBanner';
import { NetSparkline } from '@/components/overview/NetSparkline';
import { PipelineStrip } from '@/components/overview/PipelineStrip';
import { RefreshButton } from '@/components/overview/RefreshButton';
import { StatTile } from '@/components/overview/StatTile';
import { createServerSupabase } from '@/db/clients/server';
import { fetchDocuments } from '@/db/queries/documents';
import { fetchOnboardingProgress } from '@/db/queries/onboarding';
import {
  countActiveContractors,
  countFailedPayouts,
  countPendingTimeApprovals,
  getAlerts,
  getPeriodNetTotal,
  getPipelineData,
  getRecentPeriodNets,
} from '@/db/queries/overview';
import { fetchPeriodSummaries } from '@/db/queries/payroll';
import { periodFor } from '@/lib/dates/periods';
import { centavosToPhp, money } from '@/lib/format';
import { getCurrentAdmin } from '@/server/auth/admin';
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
      return state ?? '—';
  }
};

/**
 * Pay-day status phrase — port of the legacy `payday` derivation
 * (app/index.html ~11924). When the period is paid it reads "paid";
 * otherwise it is a relative phrase based on days to the pay date.
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
  const period = periodFor(today);

  const supabase = await createServerSupabase();

  const [
    activeContractors,
    currentNetTotal,
    pendingApprovals,
    failedPayouts,
    documents,
    onboardingProgress,
    pipeline,
    recentNets,
    alerts,
    periodSummaries,
    companies,
  ] = await Promise.all([
    countActiveContractors(supabase, companyId),
    getPeriodNetTotal(supabase, companyId, period.start, period.end),
    countPendingTimeApprovals(supabase, companyId),
    countFailedPayouts(supabase, companyId),
    fetchDocuments(supabase, companyId),
    fetchOnboardingProgress(supabase, companyId),
    getPipelineData(supabase, companyId, period.start, period.end),
    getRecentPeriodNets(supabase, companyId, 6),
    getAlerts(supabase, companyId, period.start, period.end),
    fetchPeriodSummaries(supabase, companyId),
    listCompanies(),
  ]);

  const companyName = companies.find((c) => c.id === companyId)?.name ?? 'This company';

  // Net total: DB PHP major units → integer centavos → display
  const netTotalCentavos = currentNetTotal != null ? Math.round(currentNetTotal * 100) : null;
  const netTotalDisplay =
    netTotalCentavos != null ? money(centavosToPhp(netTotalCentavos), 'PHP') : '—';

  // Locked-but-not-sent: count + net total across locked periods (the legacy
  // `draftN` / `draftNet`). Net is summed in integer centavos.
  const lockedPeriods = periodSummaries.filter((p) => p.state === 'locked');
  const draftN = lockedPeriods.length;
  const draftNetCentavos = lockedPeriods.reduce((s, p) => s + p.totalNetCentavos, 0);

  // Docs & onboarding (legacy `pendDocs` + `onbOpen`): documents awaiting
  // review and onboarding records not yet complete.
  const pendDocs = documents.filter((d) => d.reviewStatus === 'pending').length;
  const onbOpen = onboardingProgress.filter((o) => o.completedAt == null).length;
  const docsOnboarding = pendDocs + onbOpen;

  // Contractors needing setup = distinct workers flagged in the alerts set
  // (missing payout method or missing current rate).
  const needsSetup = new Set(alerts.map((a) => a.workerId)).size;

  // Net-pay delta vs prior period — computed from the sparkline series already
  // fetched (integer centavos, no new query).
  const lastCentavos =
    recentNets.length > 0
      ? Math.round((recentNets[recentNets.length - 1]?.totalNetPhp ?? 0) * 100)
      : null;
  const priorCentavos =
    recentNets.length > 1
      ? Math.round((recentNets[recentNets.length - 2]?.totalNetPhp ?? 0) * 100)
      : null;
  const deltaPct =
    lastCentavos != null && priorCentavos != null && priorCentavos !== 0
      ? ((lastCentavos - priorCentavos) / priorCentavos) * 100
      : null;

  const payday = paydayPhrase(pipeline.periodState, period.payDate, today);

  return (
    <>
      <div
        className="card"
        style={{
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Overview</h2>
          <div className="sub" style={{ margin: 0 }}>
            {companyName} · what needs your attention
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 6,
          }}
        >
          <RefreshButton />
          <span className="ov-updated">
            <span className="dot" />
            updated just now
          </span>
        </div>
      </div>

      <AlertsBanner alerts={alerts} />

      <div className="card ov-cycle" style={{ marginBottom: 16 }}>
        <div className="ov-cycle-head">
          <div>
            <div className="ov-tile-label" style={{ marginBottom: 4 }}>
              <span aria-hidden="true">📅</span>THIS PAY CYCLE
            </div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              {period.start} → {period.end}
            </div>
            <div className="sub" style={{ marginTop: 2 }}>
              {stateLabel(pipeline.periodState)}
              {payday ? ` · ${payday}` : ''} · {activeContractors} contractor(s)
            </div>
          </div>
          <div className="ov-cycle-net">
            <div className="ov-tile-label" style={{ justifyContent: 'flex-end' }}>
              Net this period
            </div>
            <div className="ov-tile-num">{netTotalDisplay}</div>
          </div>
        </div>
        <PipelineStrip periodStart={period.start} periodEnd={period.end} pipeline={pipeline} />
      </div>

      <div className="ov-grid" style={{ marginBottom: 16 }}>
        <StatTile
          icon="💸"
          label="Locked, not yet sent"
          value={draftN}
          sub={
            draftN > 0
              ? `${money(centavosToPhp(draftNetCentavos), 'PHP')} ready to send`
              : 'All locked pay is sent'
          }
          tone={draftN > 0 ? 'warn' : 'good'}
        />
        <StatTile
          icon="⏱"
          label="Time pending approval"
          value={pendingApprovals}
          sub={pendingApprovals > 0 ? 'time entr(ies) awaiting approval' : 'All time approved'}
          tone={pendingApprovals > 0 ? 'warn' : 'good'}
        />
        <StatTile
          icon="👤"
          label="Contractors needing setup"
          value={needsSetup}
          sub={
            needsSetup > 0
              ? 'missing payout method or current rate'
              : 'All active contractors are payroll-ready'
          }
          tone={needsSetup > 0 ? 'warn' : 'good'}
        />
        <StatTile
          icon="📄"
          label="Docs & onboarding"
          value={docsOnboarding}
          sub={
            docsOnboarding > 0
              ? `${pendDocs} doc(s) to review · ${onbOpen} onboarding open`
              : 'Nothing waiting on you'
          }
          tone={docsOnboarding > 0 ? 'info' : 'good'}
        />
        <StatTile
          icon="🚩"
          label="Payout issues"
          value={failedPayouts}
          sub={failedPayouts > 0 ? 'failed payout(s) — needs attention' : 'No failed payouts'}
          tone={failedPayouts > 0 ? 'bad' : 'good'}
        />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <NetSparkline periods={recentNets} deltaPct={deltaPct} />
      </div>

      <div className="card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <b>Data-quality</b>
            <div className="sub" style={{ margin: '4px 0 0' }}>
              Checks the latest period for contractors whose paid hours differ from tracked time.
            </div>
          </div>
          <Link className="btn ghost sm" href="/reports">
            View in Reports
          </Link>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <Link className="btn ghost sm" href="/payroll">
            Open Calculate
          </Link>
          <Link className="btn ghost sm" href="/reports">
            Open Reports
          </Link>
        </div>
      </div>
    </>
  );
}
