/**
 * Payroll service — fetch → compute → persist (NPM-Helper-App service pattern;
 * legacy `calculate()` orchestration without the React state).
 *
 * Uses the RLS user client; the caller (server action) must already have
 * verified the admin via getCurrentAdmin (ADR-0004 re-verification).
 */

import 'server-only';
import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import {
  deleteWorkerPayment,
  fetchApprovedTime,
  fetchLastPayoutMethods,
  fetchOffCycleItemsForPeriod,
  fetchPaymentRowsForRestore,
  fetchRates,
  fetchRoster,
  fetchSessionUnitsByWorkerByDate,
  findPeriod,
  type PaymentSnapshotRow,
  pruneDraftPaymentsExcept,
  upsertDraftPayments,
  upsertOpenPeriod,
} from '@/db/queries/payroll';
import {
  attributeTimeEntries,
  buildStatements,
  type StatementRow,
  toPaymentDraft,
} from '@/lib/payroll/mappers';
import { logEvent } from '@/server/audit';
import type { CalculateDraftInput } from '@/types/schemas/payroll';

export type CalculateDraftResult = {
  periodId: string;
  rows: StatementRow[];
  /** Names whose approved time couldn't be matched to a contractor (legacy warning). */
  unattributed: string[];
  /** Workers with approved time but no link in this company (legacy warning). */
  unlinkedWorkerIds: string[];
  /** Rows skipped from persistence because the worker has no rate (net null). */
  skippedNoRate: string[];
  /**
   * F6: the period's payment rows as they were BEFORE this recalc (verbatim),
   * so the UI can offer an Undo that restores manual overrides/adjustments the
   * recalc discarded. Empty on a first calculate.
   */
  priorSnapshot: PaymentSnapshotRow[];
};

/**
 * Rebuild a period's statements purely from tracked hours and persist them as
 * DRAFT. Refuses to touch a locked/paid period. Recalculating discards manual
 * overrides/adjustments for rebuilt rows and prunes rows whose worker no longer
 * has approved time (F5); the UI owns the typed-word warning, and the prior rows
 * are returned as `priorSnapshot` so the caller can offer an Undo (F6).
 */
export const calculateDraft = async (input: CalculateDraftInput): Promise<CalculateDraftResult> => {
  const db = await createServerSupabase();

  const existing = await findPeriod(db, input.companyId, input.periodStart, input.periodEnd);
  if (existing && existing.state !== 'open') {
    throw new Error(`Period is ${existing.state} — unlock it before recalculating.`);
  }
  // An off-period batch is paid ONLY from its added sessions (the ledger): no
  // tracked hours, no in-window sessions, no health allowance. It still appears
  // on Calculate and recalculates fine — it just rebuilds the ledger rows.
  const offCycleOnly = existing?.kind === 'off_cycle';

  const [entries, roster, rates, lastMethod] = await Promise.all([
    offCycleOnly
      ? Promise.resolve([] as Awaited<ReturnType<typeof fetchApprovedTime>>)
      : fetchApprovedTime(db, input.companyId, input.periodStart, input.periodEnd),
    fetchRoster(db, input.companyId),
    fetchRates(db, input.companyId),
    fetchLastPayoutMethods(db, input.companyId),
  ]);

  // Ensure the period exists & is open up-front so its id is known for the
  // off-cycle ledger read below (employer-scoped — RLS user client).
  const period = await upsertOpenPeriod(
    db,
    input.companyId,
    input.periodStart,
    input.periodEnd,
    input.payDate,
  );

  // Off-cycle per-session/per-hour pay lines, re-applied here so they survive
  // recalc (misc_items would not). byWorkerCentavos adds to net; perHourDates
  // drops in-window hours already paid off-cycle so they aren't double-paid.
  const offCycle = await fetchOffCycleItemsForPeriod(
    db,
    input.companyId,
    period.id,
    roster.map((r) => r.workerId),
  );

  // Per-session (PS) providers are paid by approved session count, not time.
  // service_sessions belong to CLIENT companies, so they're invisible under the
  // RLS user client to an admin scoped only to the employer. Payroll is
  // employer-side and must see ALL of a worker's approved client sessions
  // regardless of which admin runs it — read via the service role behind the
  // caller's already-verified admin identity (ADR-0004; see src/server/company.ts).
  // paid_at-marked sessions (already paid off-cycle) are excluded by the query.
  const sessionUnitsByWorkerByDate = offCycleOnly
    ? new Map<string, Map<string, number>>()
    : await fetchSessionUnitsByWorkerByDate(
        createServiceClient(),
        roster.map((r) => r.workerId),
        input.periodStart,
        input.periodEnd,
      );
  // Per-worker totals derived from the date buckets (PS gross + PS-only build).
  const sessionsByWorker = new Map<string, number>();
  for (const [workerId, byDate] of sessionUnitsByWorkerByDate) {
    let total = 0;
    for (const units of byDate.values()) total += units;
    sessionsByWorker.set(workerId, total);
  }

  const attribution = attributeTimeEntries(entries, roster, offCycle.perHourDatesByWorker);
  const rows = buildStatements({
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    attribution,
    roster,
    rates,
    lastPayoutMethod: lastMethod,
    includeHealthAllowance: offCycleOnly ? false : input.includeHealthAllowance,
    includeThirteenth: offCycleOnly ? false : input.includeThirteenth,
    sessionsByWorker,
    sessionUnitsByWorkerByDate,
    offCycleByWorker: offCycle.byWorkerCentavos,
  });

  // F6: snapshot the prior rows (incl. manual overrides) before we overwrite
  // them, so the caller can offer an Undo. Captured after upsertOpenPeriod so
  // period.id is known; before prune/upsert so the old values are still present.
  const priorSnapshot = await fetchPaymentRowsForRestore(db, period.id);

  const drafts = rows
    .map((r) => toPaymentDraft(r, { fxRate: input.fxRate }))
    .filter((d): d is NonNullable<typeof d> => d !== null);

  // F5: recalc is authoritative for an OPEN period — remove payment rows for
  // workers no longer in the result (their approved time was retracted) so a
  // stale row can't be locked/paid. Runs before the upsert; the period is
  // guaranteed open by the guard above.
  await pruneDraftPaymentsExcept(
    db,
    period.id,
    drafts.map((d) => d.worker_id),
  );

  await upsertDraftPayments(db, input.companyId, period.id, drafts);

  await logEvent({
    companyId: input.companyId,
    action: 'recalculate',
    entity: `${input.periodStart} → ${input.periodEnd}`,
    detail: { rows: rows.length, persisted: drafts.length },
  });

  return {
    periodId: period.id,
    rows,
    unattributed: attribution.unattributed,
    unlinkedWorkerIds: attribution.unlinkedWorkerIds,
    skippedNoRate: rows.filter((r) => r.result.net === null).map((r) => r.name),
    priorSnapshot,
  };
};

/**
 * Recompute and upsert ONE worker's draft row for an open period — used after an
 * off-cycle pay item is added/removed. Rebuilds gross from current approved
 * time/sessions (already-paid sessions are excluded by the query's paid_at
 * filter, so a freshly-paid session is never double-counted) and re-applies the
 * off-cycle ledger total. Only the target worker's row is upserted; other rows
 * (and their manual adjustments) are left untouched. Like the full recalc, this
 * resets the TARGET worker's own manual misc/bonus/pdd to the engine values.
 *
 * Caller must have verified the admin + company scope and that the period is
 * open (the payments period-open trigger also enforces it). Returns the new net
 * (PHP major units), or null when the worker has no rate / no row was produced.
 */
export const recomputeWorkerDraft = async (args: {
  companyId: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  workerId: string;
  /**
   * Off-cycle BATCH rows are built ONLY from the ledger — no hours, no in-window
   * sessions, no health allowance (the batch's window is just a label). The
   * worker's pay is the sum of their off_cycle_pay_items on this batch.
   */
  offCycleOnly?: boolean;
}): Promise<{ netPhp: number | null }> => {
  const offCycleOnly = args.offCycleOnly ?? false;
  const db = await createServerSupabase();
  const [entries, roster, rates, lastMethod] = await Promise.all([
    offCycleOnly
      ? Promise.resolve([] as Awaited<ReturnType<typeof fetchApprovedTime>>)
      : fetchApprovedTime(db, args.companyId, args.periodStart, args.periodEnd),
    fetchRoster(db, args.companyId),
    fetchRates(db, args.companyId),
    fetchLastPayoutMethods(db, args.companyId),
  ]);
  const rosterOne = roster.filter((r) => r.workerId === args.workerId);
  if (rosterOne.length === 0) return { netPhp: null }; // not on this company's roster

  const offCycle = await fetchOffCycleItemsForPeriod(db, args.companyId, args.periodId, [
    args.workerId,
  ]);
  const sessionUnitsByWorkerByDate = offCycleOnly
    ? new Map<string, Map<string, number>>()
    : await fetchSessionUnitsByWorkerByDate(
        createServiceClient(),
        [args.workerId],
        args.periodStart,
        args.periodEnd,
      );
  const sessionsByWorker = new Map<string, number>();
  for (const [workerId, byDate] of sessionUnitsByWorkerByDate) {
    let total = 0;
    for (const units of byDate.values()) total += units;
    sessionsByWorker.set(workerId, total);
  }

  const attribution = attributeTimeEntries(entries, rosterOne, offCycle.perHourDatesByWorker);
  const rows = buildStatements({
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    attribution,
    roster: rosterOne,
    rates,
    lastPayoutMethod: lastMethod,
    includeHealthAllowance: !offCycleOnly,
    includeThirteenth: false,
    sessionsByWorker,
    sessionUnitsByWorkerByDate,
    offCycleByWorker: offCycle.byWorkerCentavos,
  });
  const drafts = rows
    .map((r) => toPaymentDraft(r, {}))
    .filter((d): d is NonNullable<typeof d> => d !== null);
  if (drafts.length === 0) {
    // No payable activity left (e.g. the last off-cycle item was removed and the
    // worker had no in-period time/sessions) — drop any stale row.
    await deleteWorkerPayment(db, args.periodId, args.workerId);
    return { netPhp: null };
  }
  await upsertDraftPayments(db, args.companyId, args.periodId, drafts);
  return { netPhp: drafts[0]?.net_php ?? null };
};
