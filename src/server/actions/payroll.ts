'use server';

/**
 * Payroll server actions — WIRED (the Phase-2 pattern-setters).
 * Flow per action: verify admin (re-verification at point of use, ADR-0004) →
 * Zod-validate input → query module / service → audit log. No inline SQL,
 * no money math here — that lives in src/lib (pure) and src/db/queries.
 */

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import type {
  NewOffCycleItem,
  OffCycleItemRow,
  PeriodSummaryRow,
  ProcessPayment,
  SavedPayment,
} from '@/db/queries/payroll';
import {
  applyGrossOverride,
  clearSessionsPaid,
  composeNetCentavos,
  deleteAllStatements as dbDeleteAllStatements,
  deleteStatement as dbDeleteStatement,
  deleteOffCycleItem,
  deleteOffCycleItemsForStatements,
  fetchOffCycleItem,
  fetchOffCycleItemsForWorkerPeriod,
  fetchOffCycleTotalForWorker,
  fetchPaymentForWorker,
  fetchPeriodById,
  fetchPeriodIdsForPayments,
  fetchPeriodState,
  fetchPeriodStatesByWindow,
  fetchPeriodStatesForPayments,
  fetchPeriodSummaries,
  fetchPreviousRegularPeriodId,
  fetchPriorPayments,
  fetchProcessPayments,
  fetchRates,
  fetchRoster,
  fetchSavedPayments,
  findCurrentOpenDraft,
  findOrCreateOffCycleBatch,
  findPeriod,
  hasInAppRecalc,
  insertOffCycleItems,
  markPaymentsPaid,
  markPaymentsUnpaid,
  markSessionsPaid,
  officeToday,
  requireOpenPeriod,
  restorePaymentRows,
  setPaymentOffCycle,
  setWiseRowLock,
  stepPeriodToLocked,
  syncPeriodPaidState,
  unpayablePeriodReason,
  updatePaymentRow,
} from '@/db/queries/payroll';
import type { RateHistoryRow } from '@/db/queries/rates';
import { executeRateUpsert, fetchRateHistory } from '@/db/queries/rates';
import {
  fetchRecentSessionsForWorkers,
  fetchSessionsByIds,
  fetchUnpaidApprovedSessions,
  type RecentSessionRow,
  type UnpaidSessionRow,
} from '@/db/queries/sessions';
import { unapproveWindow } from '@/db/queries/time';
import { periodFor } from '@/lib/dates/periods';
import { humanizeError } from '@/lib/errors';
import { centavos, mulRatioMinor } from '@/lib/money';
import type { MiscItem } from '@/lib/pay/calc';
import { composeNet, miscTotal } from '@/lib/pay/calc';
import { salariedCatchUpAmount } from '@/lib/pay/catch-up';
import { payModelFor } from '@/lib/pay/expected-hours';
import { resolveRate } from '@/lib/pay/rates';
import { isCarriedOverClone } from '@/lib/payroll/carried-over';
import { centavosToPhp, phpToCentavos } from '@/lib/payroll/mappers';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import {
  type CalculateDraftResult,
  type CatchUpCandidate,
  calculateDraft,
  lockRun,
  recomputeWorkerDraft,
  reconcileApprovedTime,
  salariedCatchUpCandidates,
  unlockRun,
} from '@/server/payroll';
import {
  AddOffCyclePaySchema,
  AddSalariedCatchUpSchema,
  CalculateDraftSchema,
  DeleteAllStatementsSchema,
  DeleteStatementSchema,
  LockPeriodSchema,
  MarkAllUnpaidSchema,
  MarkPaidSchema,
  RateSaveSchema,
  RemoveOffCyclePaySchema,
  RestoreSnapshotSchema,
  ToggleWiseRowLockSchema,
  UnlockPeriodSchema,
  UpdatePaymentRowSchema,
} from '@/types/schemas/payroll';

/**
 * A period changed state (open → locked → paid). Every admin page that lists
 * batches reads that state server-side — Process & Pay, Calculate, Overview,
 * Batches — so drop the client Router Cache, which otherwise keeps replaying
 * the pre-lock render: a batch locked in Calculate stayed invisible in Process
 * & Pay (and its "waiting upstream: not yet locked" banner stayed up) until a
 * hard reload. Called from a Server Action, this clears the whole client cache,
 * which is the point — the stale entry is on the page we're NOT on.
 */
const revalidatePeriodViews = () => revalidatePath('/', 'layout');

/**
 * Effective-dated rate save (legacy `saveRate`). Same-day saves replace;
 * earlier open rates are closed; the change is audit-logged from→to.
 */
export async function saveRate(args: unknown): Promise<ActionResult<{ kind: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = RateSaveSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const result = await executeRateUpsert(db, {
      workerId: input.workerId,
      companyId: input.companyId,
      amountPhp: input.amountPhp,
      effectiveStart: input.effectiveStart,
    });
    await logEvent({
      companyId: input.companyId,
      action: 'set_rate',
      entity: input.workerId,
      detail: {
        amount_php: { from: result.priorAmountPhp, to: input.amountPhp },
        effective_start: input.effectiveStart,
        kind: result.kind,
      },
    });
    return { ok: true, data: { kind: result.kind } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Rate save failed.'),
    };
  }
}

/** Rate history for a worker in a company (newest first). */
export async function getRateHistory(args: {
  workerId: string;
  companyId: string;
}): Promise<ActionResult<{ history: RateHistoryRow[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  try {
    const db = await createServerSupabase();
    const history = await fetchRateHistory(db, args.workerId, args.companyId);
    return { ok: true, data: { history } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Lookup failed.'),
    };
  }
}

/**
 * Recalculate a period from tracked hours and save as DRAFT (legacy
 * `calculate`). The UI owns the destructive-recalc warning + undo snapshot;
 * the service refuses locked/paid periods.
 */
export async function calculatePeriodDraft(
  args: unknown,
): Promise<ActionResult<CalculateDraftResult>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = CalculateDraftSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const result = await calculateDraft(input);
    return { ok: true, data: result };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Calculate failed.'),
    };
  }
}

/**
 * F6: undo the most recent recalc. Only valid while the period is still OPEN.
 *
 * RP-23: the rows come from the snapshot calculateDraft parked on the period,
 * NOT from the caller. `RestoreSnapshotSchema.snapshot` was
 * `z.array(z.record(z.string(), z.unknown()))` and only company_id/pay_period_id
 * were forced, so every money column plus `status` and `paid_at` inserted
 * exactly as posted — bypassing the server-side net recomposition and the
 * positive-gross rule. The client's copy is now ignored (kept on the schema
 * because the payroll shell still posts it, same as CalculateDraftSchema.payDate).
 */
export async function restorePaymentsSnapshot(
  args: unknown,
): Promise<ActionResult<{ restored: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = RestoreSnapshotSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    await requireOpenPeriod(
      db,
      { periodId: input.periodId, companyId: input.companyId },
      'cannot undo recalculation',
    );

    const snapshot = await fetchPriorPayments(db, input.periodId);
    if (snapshot.length === 0)
      return { ok: false, error: 'No saved pre-recalculation snapshot for this period to undo.' };

    const restored = await restorePaymentRows(db, input.companyId, input.periodId, snapshot);
    await logEvent({
      companyId: input.companyId,
      action: 'restore_recalc',
      entity: input.periodId,
      detail: { rows: restored },
    });
    return { ok: true, data: { restored } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Undo failed.') };
  }
}

/* ---------- Period summaries (batch list) ---------- */

export async function getPeriodSummaries(args: {
  companyId: string;
}): Promise<ActionResult<{ periods: PeriodSummaryRow[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }
  try {
    const db = await createServerSupabase();
    const periods = await fetchPeriodSummaries(db, args.companyId);
    return { ok: true, data: { periods } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Lookup failed.'),
    };
  }
}

/* ---------- Saved payments for the editable draft table ---------- */

export async function getSavedPayments(args: {
  periodId: string;
  companyId: string;
}): Promise<ActionResult<{ payments: SavedPayment[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }
  try {
    const db = await createServerSupabase();
    const payments = await fetchSavedPayments(db, args.periodId);
    return { ok: true, data: { payments } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Lookup failed.'),
    };
  }
}

/* ---------- Carried-over draft auto-recalc decision ---------- */

/**
 * Should this open regular draft be auto-recalculated on open?
 *
 * A legacy sibling app that shares this prod DB seeds a new period by cloning the
 * previous period's payment rows, so the recalculate screen shows last period's
 * amounts (misleading) until this app recomputes from the period's own hours. We
 * recompute ONCE. The trigger is gated on the durable `recalculate` audit event
 * (`hasInAppRecalc`) so it never runs a second time and can never overwrite edits
 * made after the first calculate; the carried-over check scopes it to real clones
 * and backstops a best-effort audit-write that was missed.
 */
/**
 * Pull approved time that isn't on this period's batch yet. Called when Calculate
 * opens a period, so hours approved before the approve→Calculate transfer existed
 * (or through any path that doesn't hit the approve buttons) still land. Writes
 * nothing once the batch already covers every approved worker.
 */
export async function reconcilePeriodApprovedTime(args: {
  companyId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<ActionResult<{ workers: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    return { ok: true, data: await reconcileApprovedTime(args) };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Could not pull approved time onto Calculate.') };
  }
}

export async function shouldAutoRecalcDraft(args: {
  companyId: string;
  periodId: string;
}): Promise<ActionResult<{ auto: boolean }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const db = await createServerSupabase();
    const pp = await fetchPeriodById(db, args.periodId);
    if (pp?.state !== 'open' || pp.kind !== 'regular') return { ok: true, data: { auto: false } };
    // Already calculated in this app → never auto-recalc again (protects edits).
    if (await hasInAppRecalc(db, args.companyId, pp.periodStart, pp.periodEnd))
      return { ok: true, data: { auto: false } };
    const current = await fetchSavedPayments(db, args.periodId);
    if (current.length === 0) return { ok: true, data: { auto: false } };
    const prevId = await fetchPreviousRegularPeriodId(db, args.companyId, pp.periodStart);
    const previous = prevId ? await fetchSavedPayments(db, prevId) : [];
    return { ok: true, data: { auto: isCarriedOverClone(current, previous) } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Auto-recalc check failed.') };
  }
}

/* ---------- Lock period ---------- */

/**
 * Lock a pay period. Fails with the blocking reason (no-rate rows, unpaid work,
 * negative nets); when `confirmed=true` the caller has already acknowledged
 * no-method / inactive warnings. The gates live in lockRun.
 */
export async function lockPeriod(args: unknown): Promise<ActionResult<{ lockedCount: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = LockPeriodSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const data = await lockRun(input);
    revalidatePeriodViews();
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Lock failed.'),
    };
  }
}

/* ---------- Unlock period ---------- */

export async function unlockPeriod(
  args: unknown,
): Promise<ActionResult<{ periodStart: string; periodEnd: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = UnlockPeriodSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    await unlockRun(input);
    revalidatePeriodViews();
    return {
      ok: true,
      data: { periodStart: input.periodStart, periodEnd: input.periodEnd },
    };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Unlock failed.'),
    };
  }
}

/* ---------- Update a single payment row ---------- */

/**
 * Update editable fields on an open period's payment row, recomputing net
 * server-side in centavos using the same composition as the engine.
 */
export async function updatePaymentRowAction(
  args: unknown,
): Promise<ActionResult<{ netPhp: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = UpdatePaymentRowSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();

    // Fetch current row to get gross + note
    const { data: cur, error: fe } = await db
      .from('payments')
      .select(
        'gross_php, computed_gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php, bonus_php, misc_items, off_cycle_php, net_php, note, pay_period_id',
      )
      .eq('id', input.paymentId)
      .maybeSingle();
    if (fe || !cur) return { ok: false, error: 'Payment not found.' };

    // Verify period is open (and the payment's period is this company's).
    await requireOpenPeriod(
      db,
      { periodId: cur.pay_period_id, companyId: input.companyId },
      'unlock it to edit payments',
    );

    // Determine new field values
    const grossCur = phpToCentavos(cur.gross_php) ?? centavos(0);
    // RP-07: clearing an override now RESTORES the engine's gross, so gross is
    // no longer constant across an edit — net has to follow it.
    const gross =
      'grossPhpOverride' in input
        ? applyGrossOverride(
            {
              grossPhp: centavosToPhp(grossCur),
              computedGrossPhp:
                cur.computed_gross_php == null ? null : Number(cur.computed_gross_php),
              note: cur.note ?? null,
            },
            input.grossPhpOverride == null
              ? null
              : centavosToPhp(phpToCentavos(input.grossPhpOverride) ?? grossCur),
          )
        : null;
    const grossNew = gross ? (phpToCentavos(gross.grossPhp) ?? grossCur) : grossCur;

    const haNew =
      phpToCentavos(
        'haPhp' in input && input.haPhp != null
          ? input.haPhp
          : Number(cur.health_allowance_php ?? 0),
      ) ?? centavos(0);
    const t13New =
      phpToCentavos(
        't13Php' in input ? (input.t13Php ?? 0) : Number(cur.thirteenth_month_php ?? 0),
      ) ?? centavos(0);
    const pddNew =
      phpToCentavos('pddPhp' in input ? (input.pddPhp ?? 0) : Number(cur.pdd_lunch_php ?? 0)) ??
      centavos(0);
    const bonusNew =
      phpToCentavos('bonusPhp' in input ? (input.bonusPhp ?? 0) : Number(cur.bonus_php ?? 0)) ??
      centavos(0);
    const miscItemsNew: MiscItem[] = Array.isArray(input.miscItems)
      ? (input.miscItems as MiscItem[])
      : Array.isArray(cur.misc_items)
        ? (cur.misc_items as MiscItem[])
        : [];

    // Recompute net via the engine's own composeNet — one formula everywhere.
    // off_cycle_php is durable (re-applied from the ledger on recalc) — include
    // it so editing misc never silently drops it.
    const netPhp = centavosToPhp(
      composeNet(grossNew, {
        healthAllowance: haNew,
        thirteenth: t13New,
        pddLunch: pddNew,
        bonus: bonusNew,
        misc: miscTotal(miscItemsNew),
        offCycle: phpToCentavos(Number(cur.off_cycle_php ?? 0)) ?? centavos(0),
      }),
    );

    await updatePaymentRow(db, input.paymentId, {
      ...(gross
        ? {
            grossPhp: gross.grossPhp,
            computedGrossPhp: gross.computedGrossPhp,
            note: gross.note,
          }
        : {}),
      haPhp: centavosToPhp(haNew),
      t13Php: centavosToPhp(t13New),
      pddPhp: centavosToPhp(pddNew),
      bonusPhp: centavosToPhp(bonusNew),
      miscItems: miscItemsNew,
      netPhp,
      ...('payoutMethod' in input ? { payoutMethod: input.payoutMethod ?? null } : {}),
      ...('fxRate' in input && input.fxRate != null ? { fxRate: input.fxRate } : {}),
    });

    return { ok: true, data: { netPhp } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Update failed.'),
    };
  }
}

/* ---------- Delete statement(s) ---------- */

/**
 * A deleted statement takes its off-cycle ledger rows with it and frees the
 * sessions they held paid — otherwise the sessions stay marked paid against a
 * statement that no longer exists (never re-payable), while the surviving
 * ledger rows would silently re-apply the discarded pay on the next
 * recalculate. Lives here, not in the db delete helpers, because recalc's own
 * row deletes (pruneDraftPaymentsExcept / restorePaymentRows /
 * deleteWorkerPayment) must NOT release — the ledger is designed to survive
 * recalc — and the marker clear needs the service client (sessions are
 * client-company RLS-scoped, invisible to the employer admin; ADR-0004).
 */
async function releaseSessionsForDeletedStatements(
  db: Awaited<ReturnType<typeof createServerSupabase>>,
  payPeriodId: string,
  workerId?: string,
): Promise<number> {
  const sessionIds = await deleteOffCycleItemsForStatements(db, payPeriodId, workerId);
  await clearSessionsPaid(createServiceClient(), sessionIds);
  return sessionIds.length;
}

/**
 * Removing a statement is a RETRACTION, so its hours go back to Time & Approval.
 *
 * Without this the removal doesn't stick: approved time belongs on the Calculate
 * batch, so `reconcilePeriod` rebuilds the row on the very next visit (#72) and
 * the delete looks like it did nothing. Un-approving is also what the admin
 * actually wants — the reason to pull someone off a batch is to fix their hours,
 * and hours are edited on Approval, not here.
 *
 * Only on an OPEN regular period: a locked/paid run's hours must stay approved
 * (that's the salaried catch-up card's input), and off-cycle statements are paid
 * from their own ledger, not from tracked time.
 */
async function returnTimeToApproval(
  db: Awaited<ReturnType<typeof createServerSupabase>>,
  companyId: string,
  payPeriodId: string,
  workerId?: string,
): Promise<number> {
  const period = await fetchPeriodById(db, payPeriodId);
  if (period?.state !== 'open' || period.kind === 'off_cycle') return 0;
  return unapproveWindow(db, companyId, period.periodStart, period.periodEnd, workerId);
}

export async function deleteStatement(
  args: unknown,
): Promise<ActionResult<{ deleted: number; unapproved: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = DeleteStatementSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const stmt = await dbDeleteStatement(db, input.paymentId);
    const released = stmt
      ? await releaseSessionsForDeletedStatements(db, stmt.payPeriodId, stmt.workerId)
      : 0;
    const unapproved = stmt
      ? await returnTimeToApproval(db, input.companyId, stmt.payPeriodId, stmt.workerId)
      : 0;
    await logEvent({
      companyId: input.companyId,
      action: 'delete_statement',
      entity: input.paymentId,
      detail: { scope: 'contractor', released_sessions: released, unapproved_entries: unapproved },
    });
    return { ok: true, data: { deleted: 1, unapproved } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Delete failed.'),
    };
  }
}

export async function deleteAllStatements(
  args: unknown,
): Promise<ActionResult<{ deleted: number; unapproved: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = DeleteAllStatementsSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const period = await requireOpenPeriod(
      db,
      { companyId: input.companyId, start: input.periodStart, end: input.periodEnd },
      'unlock first',
    );

    const deleted = await dbDeleteAllStatements(db, period.id);
    const released = await releaseSessionsForDeletedStatements(db, period.id);
    const unapproved = await returnTimeToApproval(db, input.companyId, period.id);
    await logEvent({
      companyId: input.companyId,
      action: 'delete_statement',
      entity: `${input.periodStart} → ${input.periodEnd}`,
      detail: {
        scope: 'whole_period',
        count: deleted,
        released_sessions: released,
        unapproved_entries: unapproved,
      },
    });
    return { ok: true, data: { deleted, unapproved } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Delete failed.'),
    };
  }
}

/* ---------- Process screen: fetch payments ---------- */

export async function getProcessPayments(args: {
  periodId: string;
  companyId: string;
}): Promise<ActionResult<{ payments: ProcessPayment[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }
  try {
    const db = await createServerSupabase();
    const payments = await fetchProcessPayments(db, args.periodId);
    return { ok: true, data: { payments } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Lookup failed.'),
    };
  }
}

/* ---------- Mark paid / unpaid ---------- */

export async function markPaid(args: unknown): Promise<ActionResult<{ markedCount: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = MarkPaidSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    // RP-52: /process only ROUTES to the pay panel for a locked/paid batch —
    // this action is an HTTP endpoint, so the state must be checked here too or
    // an open period's rows flip to 'sent' mid-calculation.
    const blocked = unpayablePeriodReason(await fetchPeriodStatesForPayments(db, input.paymentIds));
    if (blocked) return { ok: false, error: blocked };

    const paidAt = input.paidAt ?? new Date().toISOString();
    // RP-61: report what actually changed — RLS and the already-paid filter
    // (RP-08) both make this smaller than the requested id list.
    const markedCount = await markPaymentsPaid(db, input.paymentIds, paidAt);
    const paidPeriodIds = await fetchPeriodIdsForPayments(db, input.paymentIds);
    await Promise.all(paidPeriodIds.map((pid) => syncPeriodPaidState(db, pid)));
    await logEvent({
      companyId: input.companyId,
      action: 'mark_paid',
      entity: input.companyId,
      detail: {
        count: markedCount,
        requested: input.paymentIds.length,
        method: 'manual',
        paid_at: paidAt,
      },
    });
    revalidatePeriodViews();
    return { ok: true, data: { markedCount } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Mark paid failed.'),
    };
  }
}

/**
 * RP-53: the per-row `markUnpaid` action is DELETED, not guarded.
 *
 * It had zero callers in src/ — the "reverse this one payment" path the UI once
 * promised never existed (that copy has since been corrected), so every one of
 * its bugs was reachable only by hand-posting to the endpoint: no
 * `wise_locked_at` check and, unlike markAllUnpaid, no `wise_transfer_id`
 * filter, so it would happily flip a funded, actually-sent Wise payment back to
 * 'draft'. The `payments_lock_enforce` trigger does not protect
 * `status`/`paid_at`, so nothing downstream would have stopped it either.
 *
 * Deleting removes the endpoint outright rather than shipping a guarded action
 * nobody calls. Reversal is still available, wired and guarded, via
 * markAllUnpaid (which excludes Wise-transfer rows). If per-row reversal is ever
 * built, re-add it WITH the wise_locked_at / wise_transfer_id filters and the
 * period-state gate below.
 */

export async function markAllUnpaid(args: unknown): Promise<ActionResult<{ markedCount: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = MarkAllUnpaidSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    // RP-52: an OPEN period has nothing to reverse, and stepPeriodToLocked below
    // would force it OUT of open — locking a draft mid-calculation.
    const blocked = unpayablePeriodReason([(await fetchPeriodState(db, input.periodId)) ?? 'open']);
    if (blocked) return { ok: false, error: blocked };

    // Only reverse non-wise-transfer rows (legacy: those with a Wise transfer need individual handling)
    const payments = await fetchProcessPayments(db, input.periodId);
    const toReverse = payments
      .filter((p) => p.status === 'sent' && !p.wiseTransferId)
      .map((p) => p.paymentId);
    if (toReverse.length > 0) {
      await markPaymentsUnpaid(db, toReverse);
      await stepPeriodToLocked(db, input.periodId);
    }
    await logEvent({
      companyId: input.companyId,
      action: 'mark_unpaid',
      entity: input.periodId,
      detail: { scope: 'all', count: toReverse.length },
    });
    revalidatePeriodViews();
    return { ok: true, data: { markedCount: toReverse.length } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Mark all unpaid failed.'),
    };
  }
}

/* ---------- Wise row lock ---------- */

export async function toggleWiseRowLock(
  args: unknown,
): Promise<ActionResult<{ lockedAt: string | null }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = ToggleWiseRowLockSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    // Unlocking (lockedAt = null) requires a reason
    if (input.lockedAt == null && !input.reason?.trim()) {
      return { ok: false, error: 'Unlock requires a reason.' };
    }
    await setWiseRowLock(db, input.paymentId, input.lockedAt ?? null);
    if (input.reason) {
      await logEvent({
        companyId: input.companyId,
        action: 'wise_lock_release',
        entity: input.paymentId,
        detail: { reason: input.reason },
      });
    }
    return { ok: true, data: { lockedAt: input.lockedAt ?? null } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Toggle lock failed.'),
    };
  }
}

/* ---------- Off-cycle per-session / per-hour pay ---------- */

export type OffCycleEligibleWorker = {
  workerId: string;
  name: string;
  basis: 'per_session' | 'per_hour';
};

/** Per-session / per-hour contractors on the company roster (off-cycle picker). */
export async function getOffCycleEligibleWorkers(args: {
  companyId: string;
}): Promise<ActionResult<{ workers: OffCycleEligibleWorker[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const db = await createServerSupabase();
    const roster = await fetchRoster(db, args.companyId);
    const workers: OffCycleEligibleWorker[] = [];
    for (const r of roster) {
      const model = payModelFor(r.contract, r.payBasis);
      if (model !== 'per_session' && model !== 'per_hour') continue;
      const name = [r.worker.firstName, r.worker.middleName, r.worker.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      workers.push({ workerId: r.workerId, name: name || r.workerId, basis: model });
    }
    workers.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, data: { workers } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Lookup failed.') };
  }
}

export type LockedPeriodSession = {
  sessionId: string;
  workerName: string;
  companyName: string;
  sessionDate: string;
  periodStart: string;
  periodEnd: string;
  periodState: 'locked' | 'paid';
};

/**
 * Of the given (just-approved) sessions, which fall in a LOCKED or PAID pay
 * period? Those won't be paid by Calculate (the period is frozen), so the
 * approve flow warns and offers to unlock that period / route off-cycle.
 */
export async function getSessionsInLockedPeriods(args: {
  companyId: string;
  sessionIds: string[];
}): Promise<ActionResult<{ sessions: LockedPeriodSession[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  if (args.sessionIds.length === 0) return { ok: true, data: { sessions: [] } };
  try {
    const { data: rows, error } = await createServiceClient()
      .from('service_sessions')
      .select('id, session_date, companies(name), workers(first_name, last_name)')
      .in('id', args.sessionIds);
    if (error) throw new Error(error.message);

    const db = await createServerSupabase();
    const stateByRange = await fetchPeriodStatesByWindow(db, args.companyId);

    const out: LockedPeriodSession[] = [];
    for (const r of rows ?? []) {
      const p = periodFor(r.session_date);
      const state = stateByRange.get(`${p.start}|${p.end}`);
      if (state === 'locked' || state === 'paid') {
        out.push({
          sessionId: r.id,
          workerName:
            [r.workers?.first_name, r.workers?.last_name].filter(Boolean).join(' ').trim() || '—',
          companyName: r.companies?.name ?? '—',
          sessionDate: r.session_date,
          periodStart: p.start,
          periodEnd: p.end,
          periodState: state,
        });
      }
    }
    return { ok: true, data: { sessions: out } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Lookup failed.') };
  }
}

/**
 * Most-recently-added sessions across the employer's per-session/per-hour
 * contractors — the always-visible "Recently added" list, so a just-entered
 * session is visible without re-picking its contractor.
 */
export async function getRecentSessions(args: {
  companyId: string;
  /** Period bounds — when set, scope the list to sessions dated within them.
   *  Omit (the "show all unpaid" toggle) to span every period. */
  start?: string;
  end?: string;
}): Promise<ActionResult<{ sessions: RecentSessionRow[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const db = await createServerSupabase();
    const roster = await fetchRoster(db, args.companyId);
    const workerIds = roster
      .filter((r) => {
        const m = payModelFor(r.contract, r.payBasis);
        return m === 'per_session' || m === 'per_hour';
      })
      .map((r) => r.workerId);
    // Service client + explicit worker-id scoping (sessions are CLIENT-company
    // RLS-scoped; we restrict to this employer's roster).
    const sessions = await fetchRecentSessionsForWorkers(createServiceClient(), workerIds, {
      ...(args.start && args.end ? { start: args.start, end: args.end } : {}),
    });
    return { ok: true, data: { sessions } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Lookup failed.') };
  }
}

/** A worker's approved, not-yet-paid sessions — the pick-mode checklist. */
export async function getUnpaidSessions(args: {
  companyId: string;
  workerId: string;
}): Promise<ActionResult<{ sessions: UnpaidSessionRow[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const sessions = await fetchUnpaidApprovedSessions(createServiceClient(), args.workerId);
    return { ok: true, data: { sessions } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Lookup failed.') };
  }
}

/** Existing off-cycle items for a worker on a period (modal list / remove). */
export async function getOffCycleItems(args: {
  companyId: string;
  periodId: string;
  workerId: string;
}): Promise<ActionResult<{ items: OffCycleItemRow[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const db = await createServerSupabase();
    const items = await fetchOffCycleItemsForWorkerPeriod(db, args.periodId, args.workerId);
    return { ok: true, data: { items } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Lookup failed.') };
  }
}

/**
 * Add an off-cycle pay entry (pick existing approved sessions, or a manual
 * date+units+description) to a per-session/per-hour contractor's row on the
 * (open) period. The session/work date need NOT fall in the period window. The
 * DB unique indexes are the hard double-pay guard; picked sessions are marked
 * paid so they leave the picker and the normal windowed sum. The worker's draft
 * row is then recomputed (gross excludes the now-paid sessions; the off-cycle
 * total is re-applied from the ledger so it survives later recalcs).
 */
export async function addOffCyclePayItem(
  args: unknown,
): Promise<ActionResult<{ netPhp: number | null; count: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = AddOffCyclePaySchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();

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
    if (!link) return { ok: false, error: "Contractor is not on this company's roster." };
    const model = payModelFor(link.contract, link.payBasis);
    if (model === 'salaried')
      return { ok: false, error: 'Off-cycle pay is only for per-session / per-hour contractors.' };
    if (model === 'unset')
      return { ok: false, error: "Set the contractor's pay basis (hourly / per session) first." };
    if (model !== input.basis)
      return {
        ok: false,
        error: `This contractor is paid ${model.replace('_', '-')}, not ${input.basis.replace('_', '-')}.`,
      };

    const rates = await fetchRates(db, input.companyId);
    const rows: NewOffCycleItem[] = [];
    const sessionIdsToMark: string[] = [];

    if (input.mode === 'pick') {
      const serviceDb = createServiceClient();
      const ids = input.sessionIds ?? [];
      const sessions = await fetchSessionsByIds(serviceDb, ids);
      if (sessions.length !== ids.length)
        return { ok: false, error: 'One or more sessions were not found.' };
      for (const s of sessions) {
        if (s.workerId !== input.workerId)
          return { ok: false, error: 'A selected session belongs to another contractor.' };
        if (s.approval !== 'approved')
          return { ok: false, error: 'Only approved sessions can be paid.' };
        if (s.paidAt) return { ok: false, error: 'A selected session has already been paid.' };
        const rate = resolveRate(rates, input.workerId, s.sessionDate, s.sessionDate);
        if (rate === null)
          return { ok: false, error: `No rate is set for ${s.sessionDate}. Set a rate first.` };
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
          return {
            ok: false,
            error: `No rate is set for ${workDate}. Set a rate or enter an amount.`,
          };
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
        return {
          ok: false,
          error:
            input.mode === 'pick'
              ? 'That session has already been paid.'
              : 'An off-cycle entry already exists for this contractor on that date.',
        };
      throw e;
    }

    if (sessionIdsToMark.length > 0) {
      await markSessionsPaid(
        createServiceClient(),
        sessionIdsToMark,
        period.id,
        null,
        new Date().toISOString(),
      );
    }

    const { netPhp } = await recomputeWorkerDraft({
      companyId: input.companyId,
      periodId: period.id,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      workerId: input.workerId,
      offCycleOnly: period.kind === 'off_cycle',
    });

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

    return { ok: true, data: { netPhp, count: rows.length } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Add off-cycle pay failed.') };
  }
}

/**
 * Salaried (FT/PT) catch-up candidates. No worker/date args → scan the most
 * recent locked/paid REGULAR period for every salaried worker (auto-detect);
 * with workerId + periodDate → single-worker quote for the manual form. Also
 * returns the salaried roster for the manual worker select.
 */
export async function getSalariedCatchUpCandidates(args: {
  companyId: string;
  workerId?: string;
  periodDate?: string;
}): Promise<
  ActionResult<{
    period: { id: string; periodStart: string; periodEnd: string } | null;
    candidates: CatchUpCandidate[];
    salariedWorkers: { workerId: string; name: string }[];
  }>
> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const db = await createServerSupabase();
    const roster = await fetchRoster(db, args.companyId);
    const salariedWorkers = roster
      .filter((r) => payModelFor(r.contract, r.payBasis) === 'salaried')
      .map((r) => ({
        workerId: r.workerId,
        name: [r.worker.firstName, r.worker.lastName].filter(Boolean).join(' ').trim(),
      }));

    let period: { id: string; periodStart: string; periodEnd: string } | null = null;
    let workerIds: string[] | undefined;
    if (args.periodDate) {
      const p = periodFor(args.periodDate);
      const found = await findPeriod(db, args.companyId, p.start, p.end);
      if (args.workerId) {
        // Manual-quote mode: a specific worker + period — hard errors so the
        // form can explain exactly why there's nothing to quote.
        if (!found)
          return {
            ok: false,
            error: 'That period was never run — its hours pay out via the regular Calculate.',
          };
        if (found.state === 'open')
          return {
            ok: false,
            error: 'That period is still open — recalculate it instead of adding a catch-up.',
          };
        period = { id: found.id, periodStart: p.start, periodEnd: p.end };
        workerIds = [args.workerId];
      } else if (found && found.state !== 'open' && found.kind === 'regular') {
        // Period-scan mode (Time page card): all salaried candidates for THIS
        // period. Open / never-run / off-cycle periods soft-return no period —
        // the caller simply renders nothing.
        period = { id: found.id, periodStart: p.start, periodEnd: p.end };
      }
    } else {
      // Newest-first summaries; the first finished regular run is the scan target.
      const sums = await fetchPeriodSummaries(db, args.companyId);
      const target = sums.find((s) => s.kind === 'regular' && s.state !== 'open');
      if (target)
        period = { id: target.id, periodStart: target.periodStart, periodEnd: target.periodEnd };
    }

    const candidates = period
      ? await salariedCatchUpCandidates({
          companyId: args.companyId,
          periodId: period.id,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          workerIds,
        })
      : [];
    return { ok: true, data: { period, candidates, salariedWorkers } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Lookup failed.') };
  }
}

/**
 * Add a salaried catch-up ledger row: leftover approved hours from an
 * already-locked/paid ORIGINAL period, paid on the open target period. The
 * amount is recomputed server-side with the strict engine cap — never taken
 * from the client. basis='salaried_hours' rows deliberately do NOT feed the
 * per-hour date-exclusion set, so unlocking + recalculating the original
 * period stays correct (remove the catch-up item first in that case).
 */
export async function addSalariedCatchUp(
  args: unknown,
): Promise<ActionResult<{ netPhp: number | null; amountPhp: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = AddSalariedCatchUpSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();

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
    if (!link) return { ok: false, error: "Contractor is not on this company's roster." };
    if (payModelFor(link.contract, link.payBasis) !== 'salaried')
      return { ok: false, error: 'Catch-up hours are only for FT/PT contractors.' };

    // Original period — the locked/paid run the hours belong to.
    const orig = periodFor(input.originalPeriodDate);
    if (orig.start === input.periodStart && orig.end === input.periodEnd)
      return {
        ok: false,
        error: 'That is the period being edited — its hours are paid by Calculate.',
      };
    const origPeriod = await findPeriod(db, input.companyId, orig.start, orig.end);
    if (!origPeriod)
      return {
        ok: false,
        error: 'That period was never run — its hours pay out via the regular Calculate.',
      };
    if (origPeriod.state === 'open')
      return {
        ok: false,
        error: 'That period is still open — recalculate it instead of adding a catch-up.',
      };

    // Price server-side: strict engine cap against what the run already paid.
    const [cand] = await salariedCatchUpCandidates({
      companyId: input.companyId,
      periodId: origPeriod.id,
      periodStart: orig.start,
      periodEnd: orig.end,
      workerIds: [input.workerId],
    });
    if (!cand) return { ok: false, error: 'Contractor not found for that period.' };
    const amount = salariedCatchUpAmount({
      rate: cand.rateCentavos,
      expectedHours: cand.expectedHours,
      paidHours: cand.paidHours,
      caughtUpHours: cand.caughtUpHours,
      leftoverHours: input.hours,
    });
    if (amount === null)
      return {
        ok: false,
        error: `No rate is set for ${orig.start} – ${orig.end}. Set a rate first.`,
      };
    if (amount === 0)
      return {
        ok: false,
        error: 'Nothing owed — that period already paid 100% of the rate for these hours.',
      };

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
        return {
          ok: false,
          error:
            'A catch-up for this contractor and period already exists — remove it first to change it.',
        };
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
      ({ netPhp } = await recomputeWorkerDraft({
        companyId: input.companyId,
        periodId: period.id,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        workerId: input.workerId,
        offCycleOnly: period.kind === 'off_cycle',
      }));
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

    return { ok: true, data: { netPhp, amountPhp: centavosToPhp(amount) } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Add catch-up pay failed.') };
  }
}

/**
 * Shared core: add APPROVED per-session sessions to `period` as off-cycle pay
 * lines (marking them paid so they leave the pickers / normal windowed sum),
 * then rebuild the affected workers' rows. `offCycleOnly` is true for the
 * dedicated batch (ledger-only rows) and false for a regular draft (the worker's
 * full row is recomputed). Used by the current-draft / next-period / off-cycle
 * routes below.
 */
async function addApprovedSessionsToPeriod(
  db: Awaited<ReturnType<typeof createServerSupabase>>,
  companyId: string,
  period: { id: string; periodStart: string; periodEnd: string },
  sessionIds: string[],
  offCycleOnly: boolean,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const roster = await fetchRoster(db, companyId);
  const rates = await fetchRates(db, companyId);
  const sessions = await fetchSessionsByIds(createServiceClient(), sessionIds);
  if (sessions.length !== sessionIds.length)
    return { ok: false, error: 'One or more sessions were not found.' };

  const rows: NewOffCycleItem[] = [];
  const sessionIdsToMark: string[] = [];
  const affectedWorkers = new Set<string>();
  for (const s of sessions) {
    if (!s.workerId) return { ok: false, error: 'A session has no contractor.' };
    if (s.approval !== 'approved')
      return { ok: false, error: 'Only approved sessions can be paid.' };
    if (s.paidAt) return { ok: false, error: 'A selected session has already been paid.' };
    const link = roster.find((r) => r.workerId === s.workerId);
    if (!link) return { ok: false, error: "A session's contractor is not on the roster." };
    if (payModelFor(link.contract, link.payBasis) !== 'per_session')
      return { ok: false, error: 'Session pay is for per-session contractors.' };
    const rate = resolveRate(rates, s.workerId, s.sessionDate, s.sessionDate);
    if (rate === null)
      return { ok: false, error: `No rate is set for ${s.sessionDate}. Set a rate first.` };
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
      return { ok: false, error: 'A selected session has already been paid.' };
    throw e;
  }
  await markSessionsPaid(
    createServiceClient(),
    sessionIdsToMark,
    period.id,
    null,
    new Date().toISOString(),
  );
  for (const workerId of affectedWorkers) {
    await recomputeWorkerDraft({
      companyId,
      periodId: period.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      workerId,
      offCycleOnly,
    });
  }
  return { ok: true, count: rows.length };
}

/**
 * Approve → pay: add approved per-session sessions to the OPEN regular draft
 * whose window contains each session's date. Returns `paidInto: 'none'` (no
 * write) when no open draft covers the date(s) — the caller then offers
 * next-period / off-cycle. A bulk selection whose dates resolve to more than
 * one outcome (different drafts, or some covered and some not) is rejected
 * with a clear message rather than silently splitting or picking one
 * (audit #001/#009 — never join a session to another period's draft).
 */
export async function payApprovedSessions(args: {
  companyId: string;
  sessionIds: string[];
}): Promise<ActionResult<{ paidInto: 'draft' | 'none'; count: number; periodStart?: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  if (args.sessionIds.length === 0) return { ok: true, data: { paidInto: 'none', count: 0 } };
  try {
    const db = await createServerSupabase();
    const sessions = await fetchSessionsByIds(createServiceClient(), args.sessionIds);
    if (sessions.length !== args.sessionIds.length)
      return { ok: false, error: 'One or more sessions were not found.' };
    const dates = [...new Set(sessions.map((s) => s.sessionDate))];
    const drafts = await Promise.all(dates.map((d) => findCurrentOpenDraft(db, args.companyId, d)));
    const resolved = new Set(drafts.map((d) => d?.id ?? 'none'));
    if (resolved.size > 1) {
      return {
        ok: false,
        error:
          'These sessions span more than one pay period (or one date has no open draft). Pay them one period at a time.',
      };
    }
    const draft = drafts[0] ?? null;
    if (!draft) return { ok: true, data: { paidInto: 'none', count: 0 } };
    const res = await addApprovedSessionsToPeriod(
      db,
      args.companyId,
      draft,
      args.sessionIds,
      false,
    );
    if (!res.ok) return res;
    await logEvent({
      companyId: args.companyId,
      action: 'pay_sessions_draft',
      entity: draft.id,
      detail: { count: res.count },
    });
    return {
      ok: true,
      data: { paidInto: 'draft', count: res.count, periodStart: draft.periodStart },
    };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Add to draft failed.') };
  }
}

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
export async function payApprovedSessionsToNextPeriod(args: {
  companyId: string;
  sessionIds: string[];
  /** Canonical period start to pay in; defaults to the sessions' own period. */
  periodStart?: string;
}): Promise<ActionResult<{ count: number; periodStart: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  if (args.sessionIds.length === 0) return { ok: false, error: 'No sessions selected.' };
  try {
    const db = await createServerSupabase();
    const sessions = await fetchSessionsByIds(createServiceClient(), args.sessionIds);
    if (sessions.length !== args.sessionIds.length)
      return { ok: false, error: 'One or more sessions were not found.' };
    const periods = new Set(sessions.map((s) => periodFor(s.sessionDate).start));
    if (periods.size > 1)
      return {
        ok: false,
        error: 'These sessions span more than one pay period. Pay them one period at a time.',
      };
    const first = sessions[0];
    if (!first) return { ok: false, error: 'No sessions selected.' };
    const owning = periodFor(first.sessionDate);
    let p = owning;
    if (args.periodStart && args.periodStart !== owning.start) {
      const chosen = periodFor(args.periodStart);
      if (chosen.start !== args.periodStart)
        return { ok: false, error: 'Pick a semi-monthly pay period (the 1st–15th or 16th–EOM).' };
      if (chosen.start < owning.start)
        return {
          ok: false,
          error: `The ${chosen.start} – ${chosen.end} period ended before this work happened. Pay it in ${owning.start} – ${owning.end} or later.`,
        };
      p = chosen;
    }
    const period = await requireOpenPeriod(
      db,
      { companyId: args.companyId, start: p.start, end: p.end, create: 'missing' },
      'use the off-period batch to pay these now',
    );
    const res = await addApprovedSessionsToPeriod(
      db,
      args.companyId,
      { id: period.id, periodStart: p.start, periodEnd: p.end },
      args.sessionIds,
      false,
    );
    if (!res.ok) return res;
    // This routes money into a run and left no trace: when Jul 1–14 sessions
    // turned up in the Jul 16–31 batch, the audit log could not say who put
    // them there or which run they meant to pick.
    await logEvent({
      companyId: args.companyId,
      action: 'pay_sessions_period',
      entity: period.id,
      detail: {
        count: res.count,
        period: `${p.start} → ${p.end}`,
        owning_period: `${owning.start} → ${owning.end}`,
        chosen: p.start !== owning.start,
      },
    });
    return { ok: true, data: { count: res.count, periodStart: p.start } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Add to next period failed.') };
  }
}

/**
 * Pay now in the dedicated OFF-CYCLE BATCH (a separate run, independent of the
 * scheduled periods). Uses the single open batch, creating one if none.
 */
export async function routeSessionsToOffCycleBatch(args: {
  companyId: string;
  sessionIds: string[];
}): Promise<ActionResult<{ batchId: string; count: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  if (args.sessionIds.length === 0) return { ok: false, error: 'No sessions selected.' };
  try {
    const db = await createServerSupabase();
    // RP-67: the batch label is the OFFICE's calendar day, not UTC's — after
    // ~8 PM in New York the UTC date is already tomorrow.
    const batch = await findOrCreateOffCycleBatch(db, args.companyId, officeToday());
    const res = await addApprovedSessionsToPeriod(
      db,
      args.companyId,
      { id: batch.id, periodStart: batch.periodStart, periodEnd: batch.periodEnd },
      args.sessionIds,
      true,
    );
    if (!res.ok) return res;
    await logEvent({
      companyId: args.companyId,
      action: 'off_cycle_batch_add',
      entity: batch.id,
      detail: { count: res.count },
    });
    return { ok: true, data: { batchId: batch.id, count: res.count } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Off-cycle batch failed.') };
  }
}

/** Direct /payroll entry: find-or-create the employer's single open off-cycle batch. */
export async function openOffCycleBatch(args: {
  companyId: string;
}): Promise<
  ActionResult<{ batchId: string; periodStart: string; periodEnd: string; isNew: boolean }>
> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const db = await createServerSupabase();
    // RP-67: the batch label is the OFFICE's calendar day, not UTC's — after
    // ~8 PM in New York the UTC date is already tomorrow.
    const batch = await findOrCreateOffCycleBatch(db, args.companyId, officeToday());
    if (batch.isNew) {
      await logEvent({
        companyId: args.companyId,
        action: 'off_cycle_batch_open',
        entity: batch.id,
        detail: {},
      });
      revalidatePeriodViews();
    }
    return {
      ok: true,
      data: {
        batchId: batch.id,
        periodStart: batch.periodStart,
        periodEnd: batch.periodEnd,
        isNew: batch.isNew,
      },
    };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Off-cycle batch failed.') };
  }
}

/** Remove an off-cycle pay item (open periods only): deletes the ledger row,
 *  unmarks any paid session, and recomputes the worker's draft net. */
export async function removeOffCyclePayItem(
  args: unknown,
): Promise<ActionResult<{ netPhp: number | null }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = RemoveOffCyclePaySchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const item = await fetchOffCycleItem(db, input.companyId, input.itemId);
    if (!item) return { ok: false, error: 'Off-cycle item not found.' };

    const period = await requireOpenPeriod(
      db,
      { periodId: item.payPeriodId, companyId: input.companyId },
      'unlock it to remove off-cycle pay',
    );

    await deleteOffCycleItem(db, input.companyId, input.itemId);
    if (item.sessionId) await clearSessionsPaid(createServiceClient(), [item.sessionId]);

    const { netPhp } = await recomputeWorkerDraft({
      companyId: input.companyId,
      periodId: period.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      workerId: item.workerId,
      offCycleOnly: period.kind === 'off_cycle',
    });

    await logEvent({
      companyId: input.companyId,
      action: 'remove_off_cycle',
      entity: item.workerId,
      detail: { item: input.itemId },
    });

    return { ok: true, data: { netPhp } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Remove off-cycle pay failed.'),
    };
  }
}
