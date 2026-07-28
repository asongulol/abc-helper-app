import { redirect } from 'next/navigation';
import { PayrollShell } from '@/components/payroll/PayrollShell';
import { createServerSupabase } from '@/db/clients/server';
import { fetchPeriodSummaries, preferredOpenDraft } from '@/db/queries/payroll';
import { periodFor, previousPeriod } from '@/lib/dates/periods';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getTrackerCompanyId } from '@/server/company';

export const metadata = { title: 'Payroll — Aaron Anderson E.H.S. LLC' };

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; unlock?: string }>;
}) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getTrackerCompanyId();
  if (!companyId) {
    return (
      <div className="card">
        <h2>Payroll</h2>
        <p className="sub">
          No employer company is configured. Add one in Config (kind = employer).
        </p>
      </div>
    );
  }

  const sp = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const isIsoDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const autoUnlock = sp.unlock === '1';

  const db = await createServerSupabase();
  const periods = await fetchPeriodSummaries(db, companyId);

  // Which period the editor opens on:
  //  1. an explicit ?period=<YYYY-MM-DD> deep-link (Process & Pay, ⌘K), else
  //  2. the open draft for the period awaiting payroll — the PRECEDING one,
  //     since payroll runs a half-month in arrears (matches /time's review
  //     default), else the most recent open draft that already has statements —
  //     so the unlocked draft opens fully instead of an empty "current period"
  //     card that just confuses (its hours aren't approved yet), else any open
  //     draft, else the arrears period itself.
  //  RP-25: (2) used to start at "newest open draft with statements", which the
  //  legacy sibling app's cloned rows made true for the IN-PROGRESS period with
  //  no admin action — hiding the period the admin actually came to calculate.
  // periodFor() throws on malformed input, so the deep-link is validated first.
  const arrears = previousPeriod(today);
  const openDraft = preferredOpenDraft(periods, arrears.start);
  const defaultPeriod = isIsoDate(sp.period)
    ? periodFor(sp.period)
    : openDraft
      ? periodFor(openDraft.periodStart)
      : arrears;

  return (
    <PayrollShell
      companyId={companyId}
      isOwner={admin.isOwner}
      defaultPeriod={defaultPeriod}
      initialPeriods={periods}
      autoUnlock={autoUnlock}
    />
  );
}
