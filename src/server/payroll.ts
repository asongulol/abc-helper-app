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
import { fetchHolidaysConfig } from '@/db/queries/holidays';
import {
  deleteWorkerPayment,
  fetchApprovedTime,
  fetchLastPayoutMethods,
  fetchOffCycleItemsForPeriod,
  fetchPaymentForWorker,
  fetchPaymentRowsForRestore,
  fetchPeriodCalcFlags,
  fetchRates,
  fetchRoster,
  fetchSalariedCatchUpUnits,
  fetchSavedPayments,
  fetchSessionUnitsByWorkerByDate,
  fetchThirteenthAccrualPeriods,
  findPeriod,
  mergeManualColumns,
  type PaymentSnapshotRow,
  pruneDraftPaymentsExcept,
  savePriorPayments,
  upsertDraftPayments,
  upsertOpenPeriod,
} from '@/db/queries/payroll';
import { periodFor } from '@/lib/dates/periods';
import type { Centavos } from '@/lib/money';
import { salariedCatchUpAmount } from '@/lib/pay/catch-up';
import { expectedHours, payModelFor } from '@/lib/pay/expected-hours';
import { resolveHolidaysForRange } from '@/lib/pay/holidays';
import { resolveRate } from '@/lib/pay/rates';
import {
  attributeTimeEntries,
  buildStatements,
  type StatementRow,
  toPaymentDraft,
} from '@/lib/payroll/mappers';
import { groupWorkersByPeriod } from '@/lib/time/grouping';
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
  /**
   * RP-29: other periods THIS YEAR that also ran the 13th-month accrual, as
   * `start → end` labels. Non-empty means this run accrues a second thirteenth
   * on top of theirs — legitimate for a split payout, a double-pay otherwise.
   */
  thirteenthAlsoOn: string[];
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

  const [entries, roster, rates, lastMethod, holidaysConfig] = await Promise.all([
    offCycleOnly
      ? Promise.resolve([] as Awaited<ReturnType<typeof fetchApprovedTime>>)
      : fetchApprovedTime(db, input.companyId, input.periodStart, input.periodEnd),
    fetchRoster(db, input.companyId),
    fetchRates(db, input.companyId),
    fetchLastPayoutMethods(db, input.companyId),
    fetchHolidaysConfig(db, input.companyId),
  ]);
  // Custom observed holidays (or code defaults for unconfigured years) — reduce
  // FT/PT expected hours. THIS is what makes the Configuration editor affect pay.
  const holidays = resolveHolidaysForRange(holidaysConfig, input.periodStart, input.periodEnd);

  // Ensure the period exists & is open up-front so its id is known for the
  // off-cycle ledger read below (employer-scoped — RLS user client).
  const period = await upsertOpenPeriod(
    db,
    input.companyId,
    input.periodStart,
    input.periodEnd,
    // RP-66: derive the arrears pay date, never trust input.payDate — the schema
    // canonicalizes the period window but not this field, so a client posting
    // payDate '2026-12-25' for Mar 1–15 would be stored verbatim and inherited
    // by payslips, statements, reports and the Wise matcher anchor.
    periodFor(input.periodStart).payDate,
    // RP-20: remember the toggles this run used, so rebuilding ONE row later
    // (an off-cycle / catch-up add) replays them instead of guessing.
    { includeHa: input.includeHealthAllowance, includeThirteenth: input.includeThirteenth },
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
    holidays,
  });

  // F6: snapshot the prior rows (incl. manual overrides) before we overwrite
  // them, so the caller can offer an Undo. Captured after upsertOpenPeriod so
  // period.id is known; before prune/upsert so the old values are still present.
  const priorSnapshot = await fetchPaymentRowsForRestore(db, period.id);
  // RP-23: park it on the period. The Undo used to post these rows back from
  // the browser and they were inserted verbatim — money columns, status and
  // paid_at included. Restoring by reference removes that trust boundary; the
  // returned copy is now only the UI's "is there anything to undo?" signal.
  await savePriorPayments(db, period.id, priorSnapshot);

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

  // RP-29: the 13th-month accrual is stateless, so ticking it on a second period
  // in the same year pays it twice. Only this layer can see the other periods.
  const thirteenthAlsoOn = input.includeThirteenth
    ? await fetchThirteenthAccrualPeriods(
        db,
        input.companyId,
        Number(input.periodStart.slice(0, 4)),
        period.id,
      )
    : [];

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
    thirteenthAlsoOn,
  };
};

/**
 * Recompute and upsert ONE worker's draft row for an open period — used after an
 * off-cycle pay item is added/removed. Rebuilds gross from current approved
 * time/sessions (already-paid sessions are excluded by the query's paid_at
 * filter, so a freshly-paid session is never double-counted) and re-applies the
 * off-cycle ledger total. Only the target worker's row is written; other rows
 * (and their manual adjustments) are left untouched.
 *
 * Caller must have verified the admin + company scope and that the period is
 * open (the payments period-open trigger also enforces it). Returns the new net
 * (PHP major units), or null when the worker has no rate / no row was produced.
 *
 * RP-20: the rebuild MERGES rather than upserts (`mergeManualColumns`), so the
 * target worker's Misc items, bonus, PDD lunch and gross override survive it.
 * The engine still owns gross/HA/13th/off-cycle: every caller but the salaried
 * catch-up marks sessions paid or frees them, which legitimately moves gross, so
 * the surgical off_cycle_php-only write addSalariedCatchUp uses would double-pay
 * here.
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
  // RP-20: replay the toggles the period's Calculate ran with. Hardcoding
  // "HA on, 13th off" here rebuilt this one worker under different rules than
  // the rest of the batch (a run with HA off silently regained it; a year-end
  // run with the 13th-month accrual on silently lost it).
  const flags = await fetchPeriodCalcFlags(db, args.periodId);
  const [entries, roster, rates, lastMethod, holidaysConfig] = await Promise.all([
    offCycleOnly
      ? Promise.resolve([] as Awaited<ReturnType<typeof fetchApprovedTime>>)
      : fetchApprovedTime(db, args.companyId, args.periodStart, args.periodEnd),
    fetchRoster(db, args.companyId),
    fetchRates(db, args.companyId),
    fetchLastPayoutMethods(db, args.companyId),
    fetchHolidaysConfig(db, args.companyId),
  ]);
  const holidays = resolveHolidaysForRange(holidaysConfig, args.periodStart, args.periodEnd);
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
    includeHealthAllowance: offCycleOnly ? false : flags.includeHa,
    includeThirteenth: offCycleOnly ? false : flags.includeThirteenth,
    sessionsByWorker,
    sessionUnitsByWorkerByDate,
    offCycleByWorker: offCycle.byWorkerCentavos,
    holidays,
  });
  const engineDrafts = rows
    .map((r) => toPaymentDraft(r, {}))
    .filter((d): d is NonNullable<typeof d> => d !== null);
  if (engineDrafts.length === 0) {
    // No payable activity left (e.g. the last off-cycle item was removed and the
    // worker had no in-period time/sessions) — drop any stale row.
    await deleteWorkerPayment(db, args.periodId, args.workerId);
    return { netPhp: null };
  }
  // RP-20: the engine owns what it computes; the row owns what a human typed.
  // Without this merge the rebuild upserted the raw draft and deleted the
  // worker's Misc items, bonus, PDD lunch and gross override.
  const existing = await fetchPaymentForWorker(db, args.periodId, args.workerId);
  const drafts = engineDrafts.map((d) => mergeManualColumns(d, existing));
  await upsertDraftPayments(db, args.companyId, args.periodId, drafts);
  return { netPhp: drafts[0]?.net_php ?? null };
};

/**
 * Move approved time onto Calculate: build (or update) the pay batch for the
 * period each approved day falls in.
 *
 * Approval used to be a flag and nothing more — the hours stayed invisible on
 * /payroll until someone pressed Calculate, and since a period with no statements
 * isn't listed there at all, 200 approved entries looked like they went nowhere.
 *
 * Same-pay-date merge: a batch is keyed on (company, period start, period end)
 * and its pay date is derived from that window, so approving the same days twice
 * lands in the batch that already exists rather than opening a second one.
 *   - empty batch  → one `calculateDraft` pass builds every row at once.
 *   - has rows     → `recomputeWorkerDraft` per touched worker, which MERGES
 *                    (RP-20): Misc items, bonus, PDD lunch and gross overrides a
 *                    human typed on the other rows survive untouched.
 *
 * Both paths rebuild from *all* currently-approved time in the window, so this is
 * idempotent and doubles as the un-approve path: retract an entry and the row is
 * rebuilt smaller, or dropped when nothing payable is left.
 *
 * Never touches a locked/paid batch (the payments trigger refuses it anyway —
 * hours approved after a run closes are the salaried catch-up card's job) or an
 * off-cycle batch (paid from its own ledger, not from tracked hours).
 */
export const syncApprovedTimeToDrafts = async (args: {
  companyId: string;
  entries: readonly { workerId: string | null; workDate: string }[];
}): Promise<{ workers: number; closedPeriods: string[] }> => {
  const db = await createServerSupabase();
  let workers = 0;
  const closedPeriods: string[] = [];

  for (const { start, end, workerIds } of groupWorkersByPeriod(args.entries)) {
    const existing = await findPeriod(db, args.companyId, start, end);
    if (existing && existing.state !== 'open') {
      closedPeriods.push(`${start} – ${end}`);
      continue;
    }
    if (existing?.kind === 'off_cycle') continue;
    // Create with the same defaults the Calculate card ticks; an existing period
    // keeps whatever toggles its last run stored (upsert would overwrite them).
    const period =
      existing ??
      (await upsertOpenPeriod(db, args.companyId, start, end, periodFor(start).payDate, {
        includeHa: true,
        includeThirteenth: false,
      }));
    const flags = await fetchPeriodCalcFlags(db, period.id);

    const saved = await fetchSavedPayments(db, period.id);
    if (saved.length === 0) {
      const result = await calculateDraft({
        companyId: args.companyId,
        periodStart: start,
        periodEnd: end,
        payDate: periodFor(start).payDate, // display-only; the server derives it (RP-66)
        includeHealthAllowance: flags.includeHa,
        includeThirteenth: flags.includeThirteenth,
      });
      workers += result.rows.length - result.skippedNoRate.length;
    } else {
      // ponytail: sequential, and each call re-reads roster/rates/holidays. Fine
      // for the incremental approvals that reach this branch (a handful of
      // workers); hoist the shared reads into a batch variant if a bulk approve
      // onto an already-built batch ever feels slow.
      for (const workerId of workerIds) {
        await recomputeWorkerDraft({
          companyId: args.companyId,
          periodId: period.id,
          periodStart: start,
          periodEnd: end,
          workerId,
        });
        workers += 1;
      }
    }
  }

  return { workers, closedPeriods };
};

export type CatchUpCandidate = {
  workerId: string;
  name: string;
  contract: string;
  expectedHours: number;
  approvedHours: number;
  paidHours: number;
  caughtUpHours: number;
  leftoverHours: number;
  rateCentavos: Centavos | null;
  /** Engine-diff amount for ALL leftover hours (centavos); null without a rate. */
  amountCentavos: Centavos | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Salaried (FT/PT) workers' approved-but-unpaid hours on an already-locked/paid
 * regular period: approved time now − hours that run paid (payments.worked_hours)
 * − hours already caught up (salaried_hours ledger rows keyed on the period_end).
 * Priced with the strict engine cap (salariedCatchUpAmount) at that period's
 * rate and holiday-adjusted expected hours — exactly what the run would have paid.
 */
export const salariedCatchUpCandidates = async (args: {
  companyId: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  workerIds?: string[] | undefined;
}): Promise<CatchUpCandidate[]> => {
  const db = await createServerSupabase();
  const [entries, roster, rates, holidaysConfig, saved] = await Promise.all([
    fetchApprovedTime(db, args.companyId, args.periodStart, args.periodEnd),
    fetchRoster(db, args.companyId),
    fetchRates(db, args.companyId),
    fetchHolidaysConfig(db, args.companyId),
    fetchSavedPayments(db, args.periodId),
  ]);
  const salaried = roster.filter(
    (r) =>
      payModelFor(r.contract, r.payBasis) === 'salaried' &&
      (!args.workerIds || args.workerIds.includes(r.workerId)),
  );
  if (salaried.length === 0) return [];
  const caughtUp = await fetchSalariedCatchUpUnits(
    db,
    args.companyId,
    args.periodEnd,
    salaried.map((r) => r.workerId),
  );
  const holidays = resolveHolidaysForRange(holidaysConfig, args.periodStart, args.periodEnd);
  // Full roster for name matching; per_hour exclusion is irrelevant to salaried.
  const attribution = attributeTimeEntries(entries, roster);
  const paidByWorker = new Map(saved.map((p) => [p.workerId, p.workedHours]));

  return salaried.map((r) => {
    const approved = round2((attribution.secondsByWorker.get(r.workerId) ?? 0) / 3600);
    const paid = paidByWorker.get(r.workerId) ?? 0;
    const caught = caughtUp.get(r.workerId) ?? 0;
    // worked_hours is stored at 2 dp — round so float dust can't mint a row.
    const leftover = Math.max(0, round2(approved - paid - caught));
    const expected = expectedHours(r.contract, args.periodStart, args.periodEnd, holidays);
    const rate = resolveRate(rates, r.workerId, args.periodStart, args.periodEnd);
    const amount = salariedCatchUpAmount({
      rate,
      expectedHours: expected,
      paidHours: paid,
      caughtUpHours: caught,
      leftoverHours: leftover,
    });
    return {
      workerId: r.workerId,
      name: [r.worker.firstName, r.worker.lastName].filter(Boolean).join(' ').trim(),
      contract: r.contract,
      expectedHours: expected,
      approvedHours: approved,
      paidHours: paid,
      caughtUpHours: caught,
      leftoverHours: leftover,
      rateCentavos: rate,
      amountCentavos: amount,
    };
  });
};
