/**
 * Outside-payment recording — the one recipe for a remittance made WITHOUT the
 * app (BPI/GCash by hand, or a Wise transfer sent from the Wise site): the row
 * is a RECORD of money that already moved, never a draft. It enters 'sent'
 * with its paid date; a Wise row enters unlinked and is then matched and
 * reconciled by the existing /batches machinery (backfill matcher, manual
 * link, reconcile-all).
 *
 * WHERE the record lands: on the covered period when the contractor's slot is
 * free; otherwise on a single-day off-cycle batch dated the paid day. A period
 * is often paid in several separate remittances, but one row per worker per
 * period is a DB constraint the calc engine (and the legacy apps' upserts)
 * depend on — so each extra remittance gets its own batch row, with the
 * covered period named in the note. Created periods are born 'locked' (never
 * 'open'), so no recalc can ever prune them and the one-open-batch unique
 * (migration 41) is never in play; the sync then steps them to 'paid'.
 *
 * Refusals, driven by who owns what:
 *  - covered period OPEN            → Calculate owns it; lock the run first.
 *  - covered row exists, NOT paid   → that money is the run's — Mark paid is
 *                                     the record for it, not a second row.
 *  - same contractor, same paid day → one outside record per day (the batch
 *                                     window is the day); nudge the date.
 *
 * Uses the PayrollDeps seam (tests pass the in-memory fake); the caller must
 * already have verified the admin via getCurrentAdmin (ADR-0004).
 */

import 'server-only';
import {
  deleteEmptyPeriod,
  fetchPaymentForWorker,
  fetchRoster,
  findPeriod,
  insertLockedPeriod,
  insertOutsidePayment,
  officeToday,
  syncPeriodPaidState,
} from '@/db/queries/payroll';
import { periodFor } from '@/lib/dates/periods';
import { logEvent } from '@/server/audit';
import { type PayrollDeps, realDeps } from '@/server/payroll';
import type { RecordOutsidePaymentInput } from '@/types/schemas/payroll';

export const recordOutsidePayment = async (
  input: RecordOutsidePaymentInput,
  deps?: PayrollDeps,
): Promise<{ paymentId: string; periodId: string }> => {
  const { db } = deps ?? (await realDeps());

  const p = periodFor(input.periodStart);
  if (p.start !== input.periodStart || p.end !== input.periodEnd)
    throw new Error('Pick a semi-monthly pay period (the 1st–15th or 16th–EOM).');
  if (input.paidOn > officeToday())
    throw new Error('The paid date is in the future — this records money that already moved.');

  const roster = await fetchRoster(db, input.companyId);
  if (!roster.some((r) => r.workerId === input.workerId))
    throw new Error("Contractor is not on this company's roster.");

  const covered = await findPeriod(db, input.companyId, p.start, p.end);
  if (covered?.state === 'open')
    throw new Error(
      'That period has an open draft — lock the run first (Calculate), then record the outside payment.',
    );

  let target: { id: string } | null = covered;
  /** Non-empty when the record lands off the covered period (slot taken). */
  let covers = '';
  if (covered) {
    const row = await fetchPaymentForWorker(db, covered.id, input.workerId);
    if (row) {
      // An unpaid in-app row for the same period is almost certainly the SAME
      // money — recording it here too is the double-record route. Mark paid is
      // the record for that row; this path is for money paid ON TOP of it.
      if (row.status !== 'sent' && row.status !== 'reconciled')
        throw new Error(
          "This contractor's row on that period is not paid yet — use Mark paid (Process & Pay) on it instead. Record an outside payment only for money paid on top of an already-paid row.",
        );
      // A second (or later) remittance for the period: its own single-day
      // batch, dated the paid day. NOTE: the Wise auto-matcher's reference
      // guard judges against THIS window, so a transfer whose reference names
      // the covered period is offered as a candidate to hand-link, not
      // auto-linked — deliberate: the operator asserted the split, not Wise.
      const day = await findPeriod(db, input.companyId, input.paidOn, input.paidOn);
      if (day?.state === 'open')
        throw new Error(
          "That day's off-cycle batch is still open — lock it first (Calculate), or use the actual paid date.",
        );
      if (day && (await fetchPaymentForWorker(db, day.id, input.workerId)))
        throw new Error(
          'An outside payment for this contractor dated that day is already recorded — one per contractor per day. Adjust the paid date by a day, or edit the existing record.',
        );
      target = day;
      covers = ` — covers ${p.start} → ${p.end}`;
    }
  }

  let created = false;
  if (!target) {
    target = covers
      ? await insertLockedPeriod(db, {
          companyId: input.companyId,
          start: input.paidOn,
          end: input.paidOn,
          payDate: input.paidOn,
          kind: 'off_cycle',
        })
      : await insertLockedPeriod(db, {
          companyId: input.companyId,
          start: p.start,
          end: p.end,
          payDate: p.payDate,
          kind: 'regular',
        });
    created = true;
  }

  const note = `Outside payment (recorded manually)${covers}${input.reference ? ` — ${input.reference}` : ''}`;
  let paymentId: string;
  try {
    paymentId = await insertOutsidePayment(db, {
      companyId: input.companyId,
      workerId: input.workerId,
      payPeriodId: target.id,
      amountPhp: input.amountPhp,
      paidOn: input.paidOn,
      payoutMethod: input.payoutMethod,
      note,
    });
  } catch (e) {
    // Don't strand an empty period this call created.
    if (created) await deleteEmptyPeriod(db, target.id);
    throw e;
  }

  // Steps 'locked' → 'paid' when every row is sent/reconciled (a just-created
  // period holds only this record, so it lands 'paid' immediately).
  await syncPeriodPaidState(db, target.id);

  await logEvent({
    companyId: input.companyId,
    action: 'record_outside_payment',
    entity: input.workerId,
    detail: {
      payment_id: paymentId,
      amount_php: input.amountPhp,
      paid_on: input.paidOn,
      method: input.payoutMethod,
      covered_period: `${p.start} → ${p.end}`,
      landed: covers ? 'off_cycle_day_batch' : 'covered_period',
      period_created: created,
      reference: input.reference ?? null,
    },
  });

  return { paymentId, periodId: target.id };
};
