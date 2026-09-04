/**
 * Off-cycle ledger service — the one recipe for paying outside a period's
 * window: validate → insert ledger rows (the DB unique indexes are the hard
 * double-pay guard) → stamp picked sessions paid → rebuild the worker's draft
 * row → audit log. The server actions are thin wrappers (auth + Zod +
 * humanizeError); domain refusals throw with the user-facing copy.
 *
 * Uses the PayrollDeps seam (tests pass the in-memory fake); the caller must
 * already have verified the admin via getCurrentAdmin (ADR-0004).
 */

import 'server-only';
import { fetchContractVersion } from '@/db/queries/contracts';
import {
  clearSessionsPaid,
  composeNetCentavos,
  deleteOffCycleItem,
  fetchOffCycleItem,
  fetchOffCycleTotalForWorker,
  fetchPaymentForWorker,
  fetchRates,
  fetchRoster,
  findCurrentOpenDraft,
  findOrCreateOffCycleBatch,
  findPeriod,
  insertOffCycleItems,
  markSessionsPaid,
  type NewOffCycleItem,
  officeToday,
  requireOpenPeriod,
  setPaymentOffCycle,
} from '@/db/queries/payroll';
import { fetchSessionsByIds } from '@/db/queries/sessions';
import { nextPeriod, periodFor } from '@/lib/dates/periods';
import { type Centavos, centavos, majorToMinor, mulRatioMinor } from '@/lib/money';
import { backpayForPaid, prorationFor } from '@/lib/pay/backpay';
import { salariedCatchUpAmount } from '@/lib/pay/catch-up';
import { payModelFor } from '@/lib/pay/expected-hours';
import { resolveRate } from '@/lib/pay/rates';
import { centavosToPhp } from '@/lib/payroll/mappers';
import { logEvent } from '@/server/audit';
import {
  type PayrollDeps,
  realDeps,
  recomputeWorkerDraft,
  salariedCatchUpCandidates,
} from '@/server/payroll';
import type {
  AddOffCyclePayInput,
  AddSalariedCatchUpInput,
  RemoveOffCyclePayInput,
} from '@/types/schemas/payroll';

/**
 * Add an off-cycle pay entry (pick existing approved sessions, or a manual
 * date+units+description) to a per-session/per-hour contractor's row on the
 * (open) period. The session/work date need NOT fall in the period window. The
 * DB unique indexes are the hard double-pay guard; picked sessions are marked
 * paid so they leave the picker and the normal windowed sum. The worker's draft
 * row is then recomputed (gross excludes the now-paid sessions; the off-cycle
 * total is re-applied from the ledger so it survives later recalcs).
 */
export const addOffCycleEntry = async (
  input: AddOffCyclePayInput,
  deps?: PayrollDeps,
): Promise<{ netPhp: number | null; count: number }> => {
  const resolved = deps ?? (await realDeps());
  const { db, serviceDb } = resolved;

  // Resolve the target period — must be open (money columns freeze otherwise).
  const period = await requireOpenPeriod(
    db,
    {
      companyId: input.companyId,
      start: input.periodStart,
      end: input.periodEnd,
      create: 'missing',
    },
    'unlock it to add off-cycle pay',
  );

  // Worker must be on the employer roster and paid per-session/per-hour.
  const roster = await fetchRoster(db, input.companyId);
  const link = roster.find((r) => r.workerId === input.workerId);
  if (!link) throw new Error("Contractor is not on this company's roster.");
  const model = payModelFor(link.contract, link.payBasis);
  if (model === 'salaried')
    throw new Error('Off-cycle pay is only for per-session / per-hour contractors.');
  if (model === 'unset')
    throw new Error("Set the contractor's pay basis (hourly / per session) first.");
  if (model !== input.basis)
    throw new Error(
      `This contractor is paid ${model.replace('_', '-')}, not ${input.basis.replace('_', '-')}.`,
    );

  const rates = await fetchRates(db, input.companyId);
  const rows: NewOffCycleItem[] = [];
  const sessionIdsToMark: string[] = [];

  if (input.mode === 'pick') {
    const ids = input.sessionIds ?? [];
    const sessions = await fetchSessionsByIds(serviceDb, ids);
    if (sessions.length !== ids.length) throw new Error('One or more sessions were not found.');
    for (const s of sessions) {
      if (s.workerId !== input.workerId)
        throw new Error('A selected session belongs to another contractor.');
      if (s.approval !== 'approved') throw new Error('Only approved sessions can be paid.');
      if (s.paidAt) throw new Error('A selected session has already been paid.');
      const rate = resolveRate(rates, input.workerId, s.sessionDate, s.sessionDate);
      if (rate === null) throw new Error(`No rate is set for ${s.sessionDate}. Set a rate first.`);
      rows.push({
        companyId: input.companyId,
        workerId: input.workerId,
        payPeriodId: period.id,
        basis: 'per_session',
        sessionId: s.id,
        workDate: s.sessionDate,
        units: s.units,
        ratePhp: centavosToPhp(rate),
        amountPhp: centavosToPhp(mulRatioMinor(rate, s.units)),
        description: input.description,
      });
      sessionIdsToMark.push(s.id);
    }
  } else {
    const workDate = input.workDate as string;
    const rate = resolveRate(rates, input.workerId, workDate, workDate);
    let amountPhp: number;
    if (input.amountPhp != null) {
      amountPhp = input.amountPhp;
    } else {
      if (rate === null)
        throw new Error(`No rate is set for ${workDate}. Set a rate or enter an amount.`);
      amountPhp = centavosToPhp(mulRatioMinor(rate, input.units ?? 0));
    }
    rows.push({
      companyId: input.companyId,
      workerId: input.workerId,
      payPeriodId: period.id,
      basis: input.basis,
      sessionId: null,
      workDate,
      units: input.units ?? null,
      ratePhp: rate === null ? null : centavosToPhp(rate),
      amountPhp,
      description: input.description,
    });
  }

  // Insert — the unique indexes reject a double-pay (session_id or worker+date).
  try {
    await insertOffCycleItems(db, rows);
  } catch (e) {
    if (e instanceof Error && e.message === 'ALREADY_PAID')
      throw new Error(
        input.mode === 'pick'
          ? 'That session has already been paid.'
          : 'An off-cycle entry already exists for this contractor on that date.',
      );
    throw e;
  }

  if (sessionIdsToMark.length > 0) {
    await markSessionsPaid(serviceDb, sessionIdsToMark, period.id, null, new Date().toISOString());
  }

  const { netPhp } = await recomputeWorkerDraft(
    {
      companyId: input.companyId,
      periodId: period.id,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      workerId: input.workerId,
      offCycleOnly: period.kind === 'off_cycle',
    },
    resolved,
  );

  await logEvent({
    companyId: input.companyId,
    action: 'add_off_cycle',
    entity: input.workerId,
    detail: {
      basis: input.basis,
      mode: input.mode,
      count: rows.length,
      amount_php: rows.reduce((s, r) => s + r.amountPhp, 0),
      period: `${input.periodStart} → ${input.periodEnd}`,
    },
  });

  return { netPhp, count: rows.length };
};

/**
 * Add a salaried catch-up ledger row: leftover approved hours from an
 * already-locked/paid ORIGINAL period, paid on the open target period. The
 * amount is recomputed server-side with the strict engine cap — never taken
 * from the client. basis='salaried_hours' rows deliberately do NOT feed the
 * per-hour date-exclusion set, so unlocking + recalculating the original
 * period stays correct (remove the catch-up item first in that case).
 */
export const addSalariedCatchUpEntry = async (
  input: AddSalariedCatchUpInput,
  deps?: PayrollDeps,
): Promise<{ netPhp: number | null; amountPhp: number }> => {
  const resolved = deps ?? (await realDeps());
  const { db } = resolved;

  // Target period — must be open (money columns freeze otherwise).
  const period = await requireOpenPeriod(
    db,
    {
      companyId: input.companyId,
      start: input.periodStart,
      end: input.periodEnd,
      create: 'missing',
    },
    'unlock it to add catch-up pay',
  );

  const roster = await fetchRoster(db, input.companyId);
  const link = roster.find((r) => r.workerId === input.workerId);
  if (!link) throw new Error("Contractor is not on this company's roster.");
  if (payModelFor(link.contract, link.payBasis) !== 'salaried')
    throw new Error('Catch-up hours are only for FT/PT contractors.');

  // Original period — the locked/paid run the hours belong to.
  const orig = periodFor(input.originalPeriodDate);
  if (orig.start === input.periodStart && orig.end === input.periodEnd)
    throw new Error('That is the period being edited — its hours are paid by Calculate.');
  const origPeriod = await findPeriod(db, input.companyId, orig.start, orig.end);
  if (!origPeriod)
    throw new Error('That period was never run — its hours pay out via the regular Calculate.');
  if (origPeriod.state === 'open')
    throw new Error('That period is still open — recalculate it instead of adding a catch-up.');

  // Price server-side: strict engine cap against what the run already paid.
  const [cand] = await salariedCatchUpCandidates(
    {
      companyId: input.companyId,
      periodId: origPeriod.id,
      periodStart: orig.start,
      periodEnd: orig.end,
      workerIds: [input.workerId],
    },
    resolved,
  );
  if (!cand) throw new Error('Contractor not found for that period.');
  const amount = salariedCatchUpAmount({
    rate: cand.rateCentavos,
    expectedHours: cand.expectedHours,
    paidHours: cand.paidHours,
    caughtUpHours: cand.caughtUpHours,
    leftoverHours: input.hours,
  });
  if (amount === null)
    throw new Error(`No rate is set for ${orig.start} – ${orig.end}. Set a rate first.`);
  if (amount === 0)
    throw new Error('Nothing owed — that period already paid 100% of the rate for these hours.');

  // ponytail: one catch-up row per (worker, original period) — the global
  // (company, worker, work_date) unique index; a top-up means remove + re-add.
  try {
    await insertOffCycleItems(db, [
      {
        companyId: input.companyId,
        workerId: input.workerId,
        payPeriodId: period.id,
        basis: 'salaried_hours',
        sessionId: null,
        workDate: orig.end,
        units: input.hours,
        ratePhp: cand.rateCentavos === null ? null : centavosToPhp(cand.rateCentavos),
        amountPhp: centavosToPhp(amount),
        description:
          input.description?.trim() ||
          `Catch-up ${link.contract} hours · ${orig.start} – ${orig.end}`,
      },
    ]);
  } catch (e) {
    if (e instanceof Error && e.message === 'ALREADY_PAID')
      throw new Error(
        'A catch-up for this contractor and period already exists — remove it first to change it.',
      );
    throw e;
  }

  // RP-20: a catch-up's hours belong to ANOTHER (locked/paid) period, so it
  // cannot change what this period's window captures — only the ledger total.
  // Update off_cycle_php + net_php in place rather than re-running the engine
  // for a gross that cannot have moved (the rebuild preserves manual columns
  // now, but it would still recompute gross from current time/sessions).
  // No row yet (the worker has no other activity here) → build one.
  const existing = await fetchPaymentForWorker(db, period.id, input.workerId);
  let netPhp: number | null;
  if (existing) {
    const offCycleC = await fetchOffCycleTotalForWorker(db, period.id, input.workerId);
    netPhp = centavosToPhp(composeNetCentavos(existing, offCycleC));
    await setPaymentOffCycle(db, existing.paymentId, centavosToPhp(offCycleC), netPhp);
  } else {
    ({ netPhp } = await recomputeWorkerDraft(
      {
        companyId: input.companyId,
        periodId: period.id,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        workerId: input.workerId,
        offCycleOnly: period.kind === 'off_cycle',
      },
      resolved,
    ));
  }

  await logEvent({
    companyId: input.companyId,
    action: 'add_off_cycle',
    entity: input.workerId,
    detail: {
      basis: 'salaried_hours',
      hours: input.hours,
      amount_php: centavosToPhp(amount),
      original_period: `${orig.start} → ${orig.end}`,
      period: `${input.periodStart} → ${input.periodEnd}`,
    },
  });

  return { netPhp, amountPhp: centavosToPhp(amount) };
};

/**
 * Shared core: add APPROVED per-session sessions to `period` as off-cycle pay
 * lines (marking them paid so they leave the pickers / normal windowed sum),
 * then rebuild the affected workers' rows. `offCycleOnly` is true for the
 * dedicated batch (ledger-only rows) and false for a regular draft (the worker's
 * full row is recomputed). Used by the current-draft / next-period / off-cycle
 * routes below.
 */
const addApprovedSessionsToPeriod = async (
  deps: PayrollDeps,
  companyId: string,
  period: { id: string; periodStart: string; periodEnd: string },
  sessionIds: string[],
  offCycleOnly: boolean,
): Promise<{ count: number }> => {
  const { db, serviceDb } = deps;
  const roster = await fetchRoster(db, companyId);
  const rates = await fetchRates(db, companyId);
  const sessions = await fetchSessionsByIds(serviceDb, sessionIds);
  if (sessions.length !== sessionIds.length)
    throw new Error('One or more sessions were not found.');

  const rows: NewOffCycleItem[] = [];
  const sessionIdsToMark: string[] = [];
  const affectedWorkers = new Set<string>();
  for (const s of sessions) {
    if (!s.workerId) throw new Error('A session has no contractor.');
    if (s.approval !== 'approved') throw new Error('Only approved sessions can be paid.');
    if (s.paidAt) throw new Error('A selected session has already been paid.');
    const link = roster.find((r) => r.workerId === s.workerId);
    if (!link) throw new Error("A session's contractor is not on the roster.");
    if (payModelFor(link.contract, link.payBasis) !== 'per_session')
      throw new Error('Session pay is for per-session contractors.');
    const rate = resolveRate(rates, s.workerId, s.sessionDate, s.sessionDate);
    if (rate === null) throw new Error(`No rate is set for ${s.sessionDate}. Set a rate first.`);
    rows.push({
      companyId,
      workerId: s.workerId,
      payPeriodId: period.id,
      basis: 'per_session',
      sessionId: s.id,
      workDate: s.sessionDate,
      units: s.units,
      ratePhp: centavosToPhp(rate),
      amountPhp: centavosToPhp(mulRatioMinor(rate, s.units)),
      description: 'Approved session',
    });
    sessionIdsToMark.push(s.id);
    affectedWorkers.add(s.workerId);
  }

  try {
    await insertOffCycleItems(db, rows);
  } catch (e) {
    if (e instanceof Error && e.message === 'ALREADY_PAID')
      throw new Error('A selected session has already been paid.');
    throw e;
  }
  await markSessionsPaid(serviceDb, sessionIdsToMark, period.id, null, new Date().toISOString());
  for (const workerId of affectedWorkers) {
    await recomputeWorkerDraft(
      {
        companyId,
        periodId: period.id,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        workerId,
        offCycleOnly,
      },
      deps,
    );
  }
  return { count: rows.length };
};

/**
 * Approve → pay: add approved per-session sessions to the OPEN regular draft
 * whose window contains each session's date. Returns `paidInto: 'none'` (no
 * write) when no open draft covers the date(s) — the caller then offers
 * next-period / off-cycle. A bulk selection whose dates resolve to more than
 * one outcome (different drafts, or some covered and some not) is rejected
 * with a clear message rather than silently splitting or picking one
 * (audit #001/#009 — never join a session to another period's draft).
 */
export const paySessionsIntoOpenDraft = async (
  args: { companyId: string; sessionIds: string[] },
  deps?: PayrollDeps,
): Promise<{ paidInto: 'draft' | 'none'; count: number; periodStart?: string }> => {
  if (args.sessionIds.length === 0) return { paidInto: 'none', count: 0 };
  const resolved = deps ?? (await realDeps());
  const { db, serviceDb } = resolved;
  const sessions = await fetchSessionsByIds(serviceDb, args.sessionIds);
  if (sessions.length !== args.sessionIds.length)
    throw new Error('One or more sessions were not found.');
  const dates = [...new Set(sessions.map((s) => s.sessionDate))];
  const drafts = await Promise.all(dates.map((d) => findCurrentOpenDraft(db, args.companyId, d)));
  const draftIds = new Set(drafts.map((d) => d?.id ?? 'none'));
  if (draftIds.size > 1) {
    throw new Error(
      'These sessions span more than one pay period (or one date has no open draft). Pay them one period at a time.',
    );
  }
  const draft = drafts[0] ?? null;
  if (!draft) return { paidInto: 'none', count: 0 };
  const { count } = await addApprovedSessionsToPeriod(
    resolved,
    args.companyId,
    draft,
    args.sessionIds,
    false,
  );
  await logEvent({
    companyId: args.companyId,
    action: 'pay_sessions_draft',
    entity: draft.id,
    detail: { count },
  });
  return { paidInto: 'draft', count, periodStart: draft.periodStart };
};

/**
 * No open draft → pay these sessions in a scheduled period, creating it open if
 * it doesn't exist yet. Defaults to the period that OWNS their dates; the caller
 * may name a LATER one via `periodStart` (the owning run is closed, or the pay
 * is deliberately held a cycle).
 *
 * Never the period containing today: payroll runs a half-month in arrears, so on
 * Jul 28 the next payroll to go out is Jul 1–15 (pay date Jul 31), not the
 * in-progress Jul 16–31 (pay date Aug 15). Keying off today pushed Jul 1–14
 * sessions a full cycle late AND joined them to a window that doesn't contain
 * them — the exact thing audit #001/#009 forbids.
 *
 * An EARLIER period is refused outright: a run whose window closed before the
 * work happened cannot be the one that pays for it. A period that is already
 * locked/paid is refused rather than reopened (requireOpenPeriod guards before
 * it creates); the off-period batch is how you pay into a closed cycle.
 */
export const paySessionsIntoPeriod = async (
  args: { companyId: string; sessionIds: string[]; periodStart?: string | undefined },
  deps?: PayrollDeps,
): Promise<{ count: number; periodStart: string }> => {
  if (args.sessionIds.length === 0) throw new Error('No sessions selected.');
  const resolved = deps ?? (await realDeps());
  const { db, serviceDb } = resolved;
  const sessions = await fetchSessionsByIds(serviceDb, args.sessionIds);
  if (sessions.length !== args.sessionIds.length)
    throw new Error('One or more sessions were not found.');
  const periods = new Set(sessions.map((s) => periodFor(s.sessionDate).start));
  if (periods.size > 1)
    throw new Error('These sessions span more than one pay period. Pay them one period at a time.');
  const first = sessions[0];
  if (!first) throw new Error('No sessions selected.');
  const owning = periodFor(first.sessionDate);
  let p = owning;
  if (args.periodStart && args.periodStart !== owning.start) {
    const chosen = periodFor(args.periodStart);
    if (chosen.start !== args.periodStart)
      throw new Error('Pick a semi-monthly pay period (the 1st–15th or 16th–EOM).');
    if (chosen.start < owning.start)
      throw new Error(
        `The ${chosen.start} – ${chosen.end} period ended before this work happened. Pay it in ${owning.start} – ${owning.end} or later.`,
      );
    p = chosen;
  }
  const period = await requireOpenPeriod(
    db,
    { companyId: args.companyId, start: p.start, end: p.end, create: 'missing' },
    'use the off-period batch to pay these now',
  );
  const { count } = await addApprovedSessionsToPeriod(
    resolved,
    args.companyId,
    { id: period.id, periodStart: p.start, periodEnd: p.end },
    args.sessionIds,
    false,
  );
  // This routes money into a run and left no trace: when Jul 1–14 sessions
  // turned up in the Jul 16–31 batch, the audit log could not say who put
  // them there or which run they meant to pick.
  await logEvent({
    companyId: args.companyId,
    action: 'pay_sessions_period',
    entity: period.id,
    detail: {
      count,
      period: `${p.start} → ${p.end}`,
      owning_period: `${owning.start} → ${owning.end}`,
      chosen: p.start !== owning.start,
    },
  });
  return { count, periodStart: p.start };
};

/**
 * Pay now in the dedicated OFF-CYCLE BATCH (a separate run, independent of the
 * scheduled periods). Uses the single open batch, creating one if none.
 */
export const paySessionsIntoOffCycleBatch = async (
  args: { companyId: string; sessionIds: string[] },
  deps?: PayrollDeps,
): Promise<{ batchId: string; count: number }> => {
  if (args.sessionIds.length === 0) throw new Error('No sessions selected.');
  const resolved = deps ?? (await realDeps());
  // RP-67: the batch label is the OFFICE's calendar day, not UTC's — after
  // ~8 PM in New York the UTC date is already tomorrow.
  const batch = await findOrCreateOffCycleBatch(resolved.db, args.companyId, officeToday());
  const { count } = await addApprovedSessionsToPeriod(
    resolved,
    args.companyId,
    { id: batch.id, periodStart: batch.periodStart, periodEnd: batch.periodEnd },
    args.sessionIds,
    true,
  );
  await logEvent({
    companyId: args.companyId,
    action: 'off_cycle_batch_add',
    entity: batch.id,
    detail: { count },
  });
  return { batchId: batch.id, count };
};

/** Remove an off-cycle pay item (open periods only): deletes the ledger row,
 *  unmarks any paid session, and recomputes the worker's draft net. */
export const removeOffCycleEntry = async (
  input: RemoveOffCyclePayInput,
  deps?: PayrollDeps,
): Promise<{ netPhp: number | null }> => {
  const resolved = deps ?? (await realDeps());
  const { db, serviceDb } = resolved;
  const item = await fetchOffCycleItem(db, input.companyId, input.itemId);
  if (!item) throw new Error('Off-cycle item not found.');

  const period = await requireOpenPeriod(
    db,
    { periodId: item.payPeriodId, companyId: input.companyId },
    'unlock it to remove off-cycle pay',
  );

  await deleteOffCycleItem(db, input.companyId, input.itemId);
  if (item.sessionId) await clearSessionsPaid(serviceDb, [item.sessionId]);

  const { netPhp } = await recomputeWorkerDraft(
    {
      companyId: input.companyId,
      periodId: period.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      workerId: item.workerId,
      offCycleOnly: period.kind === 'off_cycle',
    },
    resolved,
  );

  await logEvent({
    companyId: input.companyId,
    action: 'remove_off_cycle',
    entity: item.workerId,
    detail: { item: input.itemId },
  });

  return { netPhp };
};

/* ---------- Contract backpay (docs/CONTRACT-VERSIONS-PLAN.md slice 4b) ---------- */

export type BackpayLine = {
  periodStart: string;
  periodEnd: string;
  /** gross_php of the period's paid payment row (0 when only a catch-up exists). */
  paidPhp: number;
  /** Σ salaried catch-up rows for this period, priced at the old rate. */
  catchUpPhp: number;
  /** The rate that priced the payment row (falls back to the catch-up's). */
  oldRatePhp: number;
  coveredDays: number;
  totalDays: number;
  owedPhp: number;
  /** amount_php of an existing backpay ledger row for this period, else null. */
  addedPhp: number | null;
};

export type BackpayQuote = {
  versionId: string;
  version: number;
  workerId: string;
  companyId: string;
  effectiveFrom: string;
  newRatePhp: number;
  /** The first not-yet-closed regular period from today forward (owner decision: "next open"). */
  target: { periodStart: string; periodEnd: string } | null;
  lines: BackpayLine[];
  warnings: string[];
  /** Σ owed over lines not yet added. */
  totalPhp: number;
};

const php = (c: Centavos): number => centavosToPhp(c);
const toCentavos = (major: number): Centavos => centavos(majorToMinor(major));

/**
 * What a countersigned version still owes for periods PAID at the old rate
 * since its effective date (late reviews). One line per original regular
 * period: the payment row's gross plus any salaried catch-up rows for that
 * period (decision 5), each scaled by (new − old) / old and prorated by working
 * days on/after the effective date (decision 1). Locked-but-unpaid periods are
 * excluded with a warning — unlock + recalc is the right fix there (decision
 * 4); an open period is priced by Calculate. Read with the RLS client: a scoped
 * admin sees exactly the rows they can act on.
 */
export const quoteContractBackpay = async (
  input: { versionId: string; today?: string },
  deps?: PayrollDeps,
): Promise<BackpayQuote> => {
  const { db } = deps ?? (await realDeps());
  const v = await fetchContractVersion(db, input.versionId);
  if (!v) throw new Error('Contract version not found.');
  if (!v.countersignedAt || !v.effectiveFrom || v.ratePhp == null)
    throw new Error('Backpay is quoted from a countersigned version.');
  const eff = v.effectiveFrom;
  const newRate = toCentavos(v.ratePhp);
  // Backpay rows are keyed on the original period's START, which for the
  // prorated first period is before the effective date — hence this floor.
  const floor = periodFor(eff).start;

  const [periods, payments, ledger] = await Promise.all([
    db
      .from('pay_periods')
      .select('id, period_start, period_end, state, kind')
      .eq('company_id', v.companyId)
      .gte('period_end', eff),
    db
      .from('payments')
      .select('pay_period_id, gross_php, rate_php, paid_at')
      .eq('company_id', v.companyId)
      .eq('worker_id', v.workerId),
    db
      .from('off_cycle_pay_items')
      .select('basis, work_date, rate_php, amount_php')
      .eq('company_id', v.companyId)
      .eq('worker_id', v.workerId)
      .in('basis', ['salaried_hours', 'backpay'])
      .gte('work_date', floor),
  ]);
  for (const r of [periods, payments, ledger])
    if (r.error) throw new Error(`backpay quote: ${r.error.message}`);
  const periodById = new Map((periods.data ?? []).map((p) => [p.id, p]));

  const warnings: string[] = [];
  const byStart = new Map<string, BackpayLine>();
  const line = (start: string, end: string): BackpayLine => {
    let l = byStart.get(start);
    if (!l) {
      const pr = prorationFor(start, end, eff);
      l = {
        periodStart: start,
        periodEnd: end,
        paidPhp: 0,
        catchUpPhp: 0,
        oldRatePhp: 0,
        coveredDays: pr.coveredDays,
        totalDays: pr.totalDays,
        owedPhp: 0,
        addedPhp: null,
      };
      byStart.set(start, l);
    }
    return l;
  };
  const owe = (l: BackpayLine, paid: number, oldRate: number): void => {
    const owed = backpayForPaid({
      paid: toCentavos(paid),
      oldRate: toCentavos(oldRate),
      newRate,
      proration: prorationFor(l.periodStart, l.periodEnd, eff),
    });
    l.owedPhp = php(centavos(majorToMinor(l.owedPhp) + owed));
    if (!l.oldRatePhp) l.oldRatePhp = oldRate;
  };

  for (const p of payments.data ?? []) {
    const period = periodById.get(p.pay_period_id);
    // Not since the effective date, or an off-cycle batch (its window is a label).
    if (!period || period.kind === 'off_cycle') continue;
    const label = `${period.period_start} – ${period.period_end}`;
    if (!p.paid_at) {
      // An open period is priced by Calculate; a closed-but-unpaid one is fixed
      // by unlock + recalc, not by backpay (decision 4).
      if (period.state !== 'open')
        warnings.push(
          `${label} is ${period.state} but not paid — unlock and recalculate it instead of adding backpay.`,
        );
      continue;
    }
    const oldRate = Number(p.rate_php ?? 0);
    if (oldRate <= 0) {
      warnings.push(`${label} was paid without a rate on the row — cannot price its backpay.`);
      continue;
    }
    const l = line(period.period_start, period.period_end);
    l.paidPhp = Number(p.gross_php ?? 0);
    owe(l, l.paidPhp, oldRate);
  }

  for (const r of ledger.data ?? []) {
    if (!r.work_date) continue;
    if (r.basis === 'backpay') {
      // Keyed on period start — an existing row means this period is done.
      const l = byStart.get(r.work_date);
      if (l) l.addedPhp = Number(r.amount_php) || 0;
      else {
        const orig = periodFor(r.work_date);
        line(orig.start, orig.end).addedPhp = Number(r.amount_php) || 0;
      }
      continue;
    }
    // A catch-up is keyed on the ORIGINAL period's end and priced at that
    // period's rate — the same uplift applies to it (decision 5).
    const orig = periodFor(r.work_date);
    if (orig.end < eff) continue;
    const oldRate = Number(r.rate_php ?? 0);
    if (oldRate <= 0) continue;
    const l = line(orig.start, orig.end);
    const amount = Number(r.amount_php) || 0;
    l.catchUpPhp = php(centavos(majorToMinor(l.catchUpPhp) + majorToMinor(amount)));
    owe(l, amount, oldRate);
  }

  // The first regular period from today forward that is not locked/paid:
  // missing (Calculate will create it) or open. ponytail: three tries.
  let target: BackpayQuote['target'] = null;
  let cand = periodFor(input.today ?? officeToday());
  for (let i = 0; i < 3 && !target; i++) {
    const found = await findPeriod(db, v.companyId, cand.start, cand.end);
    if (!found || found.state === 'open') target = { periodStart: cand.start, periodEnd: cand.end };
    else cand = nextPeriod(cand.end);
  }

  const lines = [...byStart.values()].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const totalPhp = php(
    centavos(lines.reduce((s, l) => s + (l.addedPhp == null ? majorToMinor(l.owedPhp) : 0), 0)),
  );
  return {
    versionId: v.id,
    version: v.version,
    workerId: v.workerId,
    companyId: v.companyId,
    effectiveFrom: eff,
    newRatePhp: v.ratePhp,
    target,
    lines,
    warnings,
    totalPhp,
  };
};

/**
 * Add the quote's outstanding lines to the ledger on the target period — one
 * basis='backpay' row per original period, amounts recomputed server-side,
 * never taken from the client. The unique index makes a second add of the
 * same period fail loudly rather than pay twice. Then the RP-20 surgical
 * update, exactly like a catch-up: only off_cycle_php + net_php move.
 */
export const addContractBackpayEntry = async (
  input: { versionId: string; today?: string },
  deps?: PayrollDeps,
): Promise<{ netPhp: number | null; amountPhp: number; count: number }> => {
  const resolved = deps ?? (await realDeps());
  const { db } = resolved;
  const quote = await quoteContractBackpay(input, resolved);
  const lines = quote.lines.filter((l) => l.addedPhp == null && l.owedPhp > 0);
  if (lines.length === 0)
    throw new Error('Nothing to add — every paid period since the effective date is covered.');
  if (!quote.target)
    throw new Error('No open period to add backpay to — open one on Payroll first.');

  const period = await requireOpenPeriod(
    db,
    {
      companyId: quote.companyId,
      start: quote.target.periodStart,
      end: quote.target.periodEnd,
      create: 'missing',
    },
    'unlock it to add backpay',
  );

  const rate = quote.newRatePhp.toLocaleString('en-US', { minimumFractionDigits: 2 });
  const rows: NewOffCycleItem[] = lines.map((l) => ({
    companyId: quote.companyId,
    workerId: quote.workerId,
    payPeriodId: period.id,
    basis: 'backpay',
    sessionId: null,
    workDate: l.periodStart,
    units: null,
    ratePhp: quote.newRatePhp,
    amountPhp: l.owedPhp,
    description: `Backpay v${quote.version} · ${l.periodStart} – ${l.periodEnd} · ${l.coveredDays}/${l.totalDays} working days at ₱${rate}`,
  }));
  try {
    await insertOffCycleItems(db, rows);
  } catch (e) {
    if (e instanceof Error && e.message === 'ALREADY_PAID')
      throw new Error('A ledger entry for one of these periods already exists — reload.');
    throw e;
  }

  const existing = await fetchPaymentForWorker(db, period.id, quote.workerId);
  let netPhp: number | null;
  if (existing) {
    const offCycleC = await fetchOffCycleTotalForWorker(db, period.id, quote.workerId);
    netPhp = centavosToPhp(composeNetCentavos(existing, offCycleC));
    await setPaymentOffCycle(db, existing.paymentId, centavosToPhp(offCycleC), netPhp);
  } else {
    ({ netPhp } = await recomputeWorkerDraft(
      {
        companyId: quote.companyId,
        periodId: period.id,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        workerId: quote.workerId,
        offCycleOnly: period.kind === 'off_cycle',
      },
      resolved,
    ));
  }

  const amountPhp = php(centavos(lines.reduce((s, l) => s + majorToMinor(l.owedPhp), 0)));
  await logEvent({
    companyId: quote.companyId,
    action: 'contract.backpay',
    entity: quote.workerId,
    detail: {
      version: quote.version,
      version_id: quote.versionId,
      effective_from: quote.effectiveFrom,
      periods: lines.map((l) => `${l.periodStart} → ${l.periodEnd}`),
      amount_php: amountPhp,
      paid_on: `${period.periodStart} → ${period.periodEnd}`,
    },
  });
  return { netPhp, amountPhp, count: rows.length };
};
