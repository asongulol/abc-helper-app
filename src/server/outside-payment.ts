/**
 * Outside-payment recording — the one recipe for a remittance made WITHOUT the
 * app (BPI/GCash by hand, or a Wise transfer sent from the Wise site): the row
 * is a RECORD of money that already moved, never a draft. It enters 'sent'
 * with its paid date; a Wise row enters unlinked and is then matched and
 * reconciled by the existing /batches machinery (backfill matcher, manual
 * link, reconcile-all).
 *
 * Period rules, driven by who owns each state:
 *  - locked/paid  → append the record (the trigger admits this shape,
 *                   migration 42) — this is the normal case: the run happened
 *                   outside the app, so the period is usually already closed.
 *  - missing      → create it, insert, and lock it immediately, so the record
 *                   never sits where a recalc could prune it.
 *  - open         → refused. Calculate owns open periods and its recalc
 *                   prunes/overwrites rows freely; a record inserted there
 *                   could be silently destroyed.
 *
 * Uses the PayrollDeps seam (tests pass the in-memory fake); the caller must
 * already have verified the admin via getCurrentAdmin (ADR-0004).
 */

import 'server-only';
import {
  deleteEmptyOpenPeriod,
  fetchPaymentForWorker,
  fetchRoster,
  findPeriod,
  insertOutsidePayment,
  officeToday,
  stepPeriodToLocked,
  syncPeriodPaidState,
  upsertOpenPeriod,
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

  const existing = await findPeriod(db, input.companyId, p.start, p.end);
  if (existing?.state === 'open')
    throw new Error(
      'That period has an open draft — lock the run first (Calculate), then record the outside payment.',
    );
  if (existing && (await fetchPaymentForWorker(db, existing.id, input.workerId)))
    throw new Error(
      'This contractor already has a row on that period — use Mark paid (Process & Pay) or Wise matching on it instead.',
    );

  const period =
    existing ?? (await upsertOpenPeriod(db, input.companyId, p.start, p.end, p.payDate));

  const note = `Outside payment (recorded manually)${input.reference ? ` — ${input.reference}` : ''}`;
  let paymentId: string;
  try {
    paymentId = await insertOutsidePayment(db, {
      companyId: input.companyId,
      workerId: input.workerId,
      payPeriodId: period.id,
      amountPhp: input.amountPhp,
      paidOn: input.paidOn,
      payoutMethod: input.payoutMethod,
      note,
    });
  } catch (e) {
    // Don't strand an empty open period this call created.
    if (!existing) await deleteEmptyOpenPeriod(db, period.id);
    throw e;
  }

  // A freshly-created period holds only records of moved money — close it now
  // so it shows up in /batches and no recalc can ever touch it. The sync then
  // steps locked → paid when every row is sent/reconciled.
  if (!existing) await stepPeriodToLocked(db, period.id);
  await syncPeriodPaidState(db, period.id);

  await logEvent({
    companyId: input.companyId,
    action: 'record_outside_payment',
    entity: input.workerId,
    detail: {
      payment_id: paymentId,
      amount_php: input.amountPhp,
      paid_on: input.paidOn,
      method: input.payoutMethod,
      period: `${p.start} → ${p.end}`,
      period_created: !existing,
      reference: input.reference ?? null,
    },
  });

  return { paymentId, periodId: period.id };
};
