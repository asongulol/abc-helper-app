import { PortalDashboard } from '@/components/portal/PortalDashboard';
import { createServerSupabase } from '@/db/clients/server';
import {
  fetchAnnouncements,
  fetchOwnDocuments,
  fetchOwnPayments,
  fetchOwnProfile,
  fetchOwnTimeEntries,
  fetchPortalSettings,
} from '@/db/queries/portal';
import { getCurrentWorker } from '@/server/auth/worker';
import { redirect } from 'next/navigation';

const pad = (n: number) => String(n).padStart(2, '0');

/** Current semi-monthly period (Manila), mirroring the legacy curPeriod(). */
function curPeriod(todayISO: string): { start: string; end: string; pay: string } {
  const [y, m, d] = todayISO.split('-').map(Number);
  const yy = y ?? 2026;
  const mm = m ?? 1;
  const dd = d ?? 1;
  const lastDay = new Date(yy, mm, 0).getDate();
  const iso = (day: number) => `${yy}-${pad(mm)}-${pad(day)}`;
  if (dd <= 15) return { start: iso(1), end: iso(15), pay: `${yy}-${pad(mm)}-${pad(lastDay)}` };
  const ny = mm === 12 ? yy + 1 : yy;
  const nm = mm === 12 ? 1 : mm + 1;
  return { start: iso(16), end: iso(lastDay), pay: `${ny}-${pad(nm)}-15` };
}

export default async function PortalHomePage() {
  const worker = await getCurrentWorker();
  if (!worker) redirect('/portal/login');

  const supabase = await createServerSupabase();
  const [announcements, payments, timeEntries, ownDocs, settings, profile] = await Promise.all([
    fetchAnnouncements(supabase),
    fetchOwnPayments(supabase, worker.workerId),
    fetchOwnTimeEntries(supabase, worker.workerId),
    fetchOwnDocuments(supabase, worker.workerId),
    fetchPortalSettings(supabase),
    fetchOwnProfile(supabase, worker.workerId),
  ]);

  // Greeting name: nickname (profile_extras) → first name.
  const extras =
    profile?.profile_extras && typeof profile.profile_extras === 'object'
      ? (profile.profile_extras as Record<string, unknown>)
      : {};
  const greetName = (String(extras.nickname ?? '').trim() || worker.firstName || '').trim();

  // Required onboarding docs the contractor still owes (reminder overlay).
  const onbConfig = (settings?.onboarding_config ?? {}) as {
    documents?: { kind: string; title: string; required?: boolean }[];
  };
  const haveKinds = new Set(ownDocs.map((d) => d.kind as string));
  const pendingDocs = worker.onboarded
    ? []
    : (onbConfig.documents ?? [])
        .filter((d) => d.required !== false && !haveKinds.has(d.kind))
        .map((d) => d.title);

  // Activity %: tracked-weighted per worked day (has activity), most recent 18.
  const agg = new Map<string, { s: number; w: number }>();
  for (const t of timeEntries) {
    if (t.activityPct == null) continue;
    const w = Math.max(t.trackedSeconds, 1);
    const a = agg.get(t.workDate) ?? { s: 0, w: 0 };
    a.s += t.activityPct * w;
    a.w += w;
    agg.set(t.workDate, a);
  }
  const activity = [...agg.keys()]
    .sort()
    .map((date) => {
      const a = agg.get(date);
      return { date, activity: a ? Math.round(a.s / a.w) : 0 };
    })
    .slice(-18);

  // Pay timeline.
  const todayManila = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(
    new Date(),
  );
  const period = curPeriod(todayManila);
  const dNum = (iso: string) => Number(iso.slice(8, 10));
  const totalDays = Math.max(1, dNum(period.end) - dNum(period.start) + 1);
  const elapsedDays = Math.min(totalDays, Math.max(0, dNum(todayManila) - dNum(period.start) + 1));
  const pct = Math.round((elapsedDays / totalDays) * 100);
  const isPaid = (s: string) => s === 'sent' || s === 'reconciled';
  const sortedPays = [...payments].sort((a, b) =>
    String(b.payDate ?? '').localeCompare(String(a.payDate ?? '')),
  );
  const lastPaidRow = sortedPays.find((p) => isPaid(p.status));
  const nextPayRow = sortedPays.find((p) => !isPaid(p.status));
  const homePay = {
    period,
    nextPay: nextPayRow ? { net: nextPayRow.netPhp, pay: nextPayRow.payDate } : null,
    lastPaid: lastPaidRow ? { net: lastPaidRow.netPhp, pay: lastPaidRow.payDate } : null,
    elapsedDays,
    totalDays,
    pct,
  };

  const { data: toolsPendingData } = await supabase.rpc('my_tools_pending');
  const toolsPending = toolsPendingData === true;

  return (
    <PortalDashboard
      greetName={greetName}
      onboarded={worker.onboarded}
      announcements={announcements}
      homePay={homePay}
      activity={activity}
      pendingDocs={pendingDocs}
      toolsPending={toolsPending}
    />
  );
}
