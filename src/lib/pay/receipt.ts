/**
 * "How this pay was computed" receipt model — shared by the admin reports
 * history (ReportsClient), the contractor portal pay-slip list, and the
 * printable pay slip. Assembled from the STORED statement inputs only (never
 * recomputed — old rows must not drift). Zero components are never listed:
 * not every contractor is entitled to health allowance / 13th / lunch, and a
 * ₱0 line would imply they are. The formula line only claims "=" when the
 * stored inputs actually reproduce the stored gross; otherwise the basis SAYS
 * why no formula can be shown instead of going silent. Owner rule: no
 * exchange-rate information anywhere — this view is shown to contractors.
 */

import { money } from '@/lib/format';
import { payoutMethodLabel } from '@/lib/payroll/status-pills';

/** Misc item flattened for display: deductions arrive already negative. */
export type ReceiptMisc = { label: string; amount: number };

/** The stored statement inputs the receipt is assembled from. */
export type ReceiptInput = {
  gross: number | null;
  net: number | null;
  method: string | null;
  /** Payable hours the statement was saved with (includes PTO). */
  workedPay: number | null;
  /** Tracked hours from time entries, when the caller has them (else null). */
  worked: number | null;
  pto: number;
  expected: number | null;
  ratio: number | null;
  rate: number | null;
  computedGross: number | null;
  ha: number | null;
  t13: number | null;
  lunch: number | null;
  bonus: number | null;
  offCycle: number;
  misc: ReceiptMisc[];
  units: number | null;
  perSession: boolean;
  payout: number | null;
  payoutCur: string | null;
};

const num = (n: number): string => n.toFixed(2);

/**
 * Flatten stored `misc_items` JSON to signed display amounts: deduction-kind
 * items are stored positive but subtract from net, so the receipt can render
 * one +/− list. Zero-amount lines are dropped.
 */
export const flattenMisc = (items: unknown): ReceiptMisc[] =>
  (Array.isArray(items) ? items : [])
    .map((m) => {
      const it = m as { kind?: string; label?: string; amount?: number | string | null };
      const amt = Number(it?.amount) || 0;
      return {
        label: it?.label || (it?.kind === 'deduction' ? 'Deduction' : 'Adjustment'),
        amount: it?.kind === 'deduction' ? -amt : amt,
      };
    })
    .filter((m) => m.amount !== 0);

/**
 * Build the receipt: gross basis sentence, the formula gross, signed extra
 * lines that sum to the stored net, and the paid line (never any FX). `php`
 * formats PHP amounts embedded in sentences — the admin renders "PHP 1,234.56",
 * the portal "₱1,234.56".
 */
export const receiptModel = (
  r: ReceiptInput,
  php: (n: number) => string = (n) => money(n, 'PHP'),
): {
  basis: string | null;
  gross: number;
  extras: Array<[string, number]>;
  paid: string | null;
} => {
  const gross = r.gross ?? 0;
  const adjusted = r.computedGross != null && Math.abs(r.computedGross - gross) >= 0.01;
  const formulaGross = adjusted ? (r.computedGross ?? 0) : gross;

  // Payable hours include PTO; spell the split out when the time entries
  // actually account for the stored payable figure.
  const ptoPart =
    r.pto > 0 &&
    r.workedPay != null &&
    r.worked != null &&
    Math.abs(r.workedPay - (r.worked + r.pto)) <= 0.05
      ? ` (${num(r.worked)} h worked + ${num(r.pto)} h PTO)`
      : '';
  const hoursCtx =
    r.workedPay != null
      ? `${num(r.workedPay)} h${ptoPart}`
      : r.worked != null
        ? `${num(r.worked)} h${r.pto > 0 ? ` + ${num(r.pto)} h PTO` : ''}`
        : null;
  const MANUAL = 'stored inputs do not reproduce this gross (likely entered manually)';

  let basis: string;
  if (r.rate != null && r.expected != null && r.expected > 0 && r.workedPay != null) {
    const ratio = r.ratio ?? r.workedPay / r.expected;
    // Owner rule: the explanation never shows hours beyond the required
    // hours — pay caps at the rate, so only the payable portion is shown.
    const payable = Math.min(r.workedPay, r.expected);
    if (Math.abs(Math.min(ratio, 1) * r.rate - formulaGross) <= 1) {
      basis =
        ratio >= 1
          ? `${num(payable)} h of ${num(r.expected)} h required — full period rate ${php(r.rate)}`
          : `${num(payable)} h${ptoPart} ÷ ${num(r.expected)} h required = ${(ratio * 100).toFixed(1)}% × ${php(r.rate)} period rate`;
    } else {
      basis = `${MANUAL} — amounts shown as saved`;
    }
  } else if (r.rate != null && r.units != null && r.units > 0) {
    if (Math.abs(r.units * r.rate - formulaGross) <= 1) {
      basis = r.perSession
        ? `${num(r.units)} sessions × ${php(r.rate)} per session`
        : `${num(r.units)} h × ${php(r.rate)} per hour`;
    } else {
      basis = `${MANUAL} — amounts shown as saved`;
    }
  } else {
    // Legacy statements saved without rate / required hours: still give the
    // reader every stored fact instead of an unexplained bare amount.
    basis = `saved without its rate and required hours${
      hoursCtx ? ` (${hoursCtx} this period)` : ''
    } — amounts shown as saved`;
  }

  const extras: Array<[string, number]> = [];
  if (r.ha) extras.push(['Health allowance', r.ha]);
  if (r.t13) extras.push(['13th-month accrual', r.t13]);
  if (r.lunch) extras.push(['PDD lunch', r.lunch]);
  if (r.bonus) extras.push(['Bonus', r.bonus]);
  if (r.offCycle) extras.push(['Off-cycle pay', r.offCycle]);
  for (const m of r.misc) extras.push([m.label, m.amount]);
  if (adjusted) extras.unshift(['Manual gross adjustment', gross - (r.computedGross ?? 0)]);

  // Keep the column arithmetically honest on legacy rows where the stored
  // components don't reach the stored net (e.g. reconcile-edited nets).
  const resid = (r.net ?? 0) - (formulaGross + extras.reduce((s, [, v]) => s + v, 0));
  if (Math.abs(resid) >= 0.01) extras.push(['Unattributed difference', resid]);

  // Owner rule: never show exchange-rate information — contractors see this.
  const paid =
    r.payout != null
      ? `Paid ${
          !r.payoutCur || r.payoutCur === 'USD'
            ? money(r.payout, 'USD')
            : `${num(r.payout)} ${r.payoutCur}`
        }${payoutMethodLabel(r.method) ? ` via ${payoutMethodLabel(r.method)}` : ''}`
      : null;

  return { basis, gross: formulaGross, extras, paid };
};
