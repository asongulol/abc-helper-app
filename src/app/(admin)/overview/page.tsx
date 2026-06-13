import { AlertsBanner } from '@/components/overview/AlertsBanner';
import { NetSparkline } from '@/components/overview/NetSparkline';
import { PipelineStrip } from '@/components/overview/PipelineStrip';
import { StatTile } from '@/components/overview/StatTile';
import { createServerSupabase } from '@/db/clients/server';
import {
  countActiveContractors,
  countExpiringDocuments,
  countPendingTimeApprovals,
  getAlerts,
  getPeriodCounts,
  getPeriodNetTotal,
  getPipelineData,
  getRecentPeriodNets,
} from '@/db/queries/overview';
import { periodFor } from '@/lib/dates/periods';
import { centavosToPhp, fmtDate, money } from '@/lib/format';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Overview — ABC Kids HR' };

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
    periodCounts,
    currentNetTotal,
    pendingApprovals,
    expiringDocs,
    pipeline,
    recentNets,
    alerts,
  ] = await Promise.all([
    countActiveContractors(supabase, companyId),
    getPeriodCounts(supabase, companyId),
    getPeriodNetTotal(supabase, companyId, period.start, period.end),
    countPendingTimeApprovals(supabase, companyId),
    countExpiringDocuments(supabase, companyId),
    getPipelineData(supabase, companyId, period.start, period.end),
    getRecentPeriodNets(supabase, companyId, 8),
    getAlerts(supabase, companyId, period.start, period.end),
  ]);

  // Net total: DB PHP major units → integer centavos → display
  const netTotalCentavos = currentNetTotal != null ? Math.round(currentNetTotal * 100) : null;
  const netTotalDisplay = netTotalCentavos != null ? money(centavosToPhp(netTotalCentavos)) : '—';

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Overview</h2>
        <p className="sub">
          Period: {fmtDate(period.start)} – {fmtDate(period.end)} · Pay date:{' '}
          {fmtDate(period.payDate)}
        </p>
      </div>

      <AlertsBanner alerts={alerts} />

      <div className="ov-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Active contractors"
          value={activeContractors}
          tone={activeContractors > 0 ? 'good' : 'neutral'}
          icon="👥"
        />
        <StatTile
          label="Open periods"
          value={periodCounts.open}
          tone={periodCounts.open > 0 ? 'warn' : 'neutral'}
          icon="📂"
        />
        <StatTile
          label="Locked periods"
          value={periodCounts.locked}
          tone={periodCounts.locked > 0 ? 'info' : 'neutral'}
          icon="🔒"
        />
        <StatTile
          label="Current period net"
          value={netTotalDisplay}
          sub="sum of net_php"
          tone={netTotalCentavos != null ? 'info' : 'neutral'}
          icon="💰"
        />
        <StatTile
          label="Pending time approvals"
          value={pendingApprovals}
          tone={pendingApprovals > 0 ? 'warn' : 'good'}
          icon="⏳"
        />
        <StatTile
          label="Expiring documents"
          sub="next 30 days"
          value={expiringDocs}
          tone={expiringDocs > 0 ? 'bad' : 'good'}
          icon="📄"
        />
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 16 }}>Pay-cycle pipeline</h3>
        <PipelineStrip periodStart={period.start} periodEnd={period.end} pipeline={pipeline} />
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 16 }}>Net pay — recent periods</h3>
        <NetSparkline periods={recentNets} />
      </div>
    </>
  );
}
