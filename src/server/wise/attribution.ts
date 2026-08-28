import 'server-only';

import { composeNetCentavos } from '@/db/queries/payroll';
import { centavos, majorToMinor } from '@/lib/money';
import type { MiscItem } from '@/lib/pay/calc';
import { centavosToPhp } from '@/lib/payroll/mappers';

/**
 * Attributing a reconcile variance.
 *
 * When Wise sent a different amount than the payroll row says, the matcher used
 * to silently restate `net_php` from the transfer and stash the old value in
 * `original_net_php` — the payroll record rewritten to match the bank, with no
 * record of WHY they differed. This is the replacement: the operator says where
 * the difference belongs, and the row gains a line that explains it.
 *
 * The amount is never client input. It is `wiseAmount − net_php`, computed
 * server-side from the linked transfer, so the control can only ever close the
 * gap it was opened for.
 */

export type AttributionTarget = 'misc' | 'health_allowance' | 'thirteenth_month';

/** The payment columns that compose net. */
export interface AttributableRow {
  /** NOT NULL in the schema — a persisted row always has a priced gross. */
  gross_php: number;
  health_allowance_php: number | null;
  thirteenth_month_php: number | null;
  pdd_lunch_php: number | null;
  bonus_php: number | null;
  misc_items: MiscItem[] | null;
  off_cycle_php: number | null;
}

export interface AttributionPlan {
  /** Columns to write (shape of `updatePaymentRow`'s fields). */
  haPhp?: number;
  t13Php?: number;
  miscItems?: MiscItem[];
  netPhp: number;
  /** For the audit event, so one read reverses this exactly. */
  prevValue: number | null;
  item: MiscItem | null;
}

const RECONCILE_SOURCE = 'reconcile';

const num = (v: number | null | undefined): number => Number(v ?? 0);

const netOf = (row: AttributableRow, over: Partial<AttributableRow>): number =>
  centavosToPhp(
    composeNetCentavos(
      {
        grossPhp: over.gross_php ?? row.gross_php,
        haPhp: num(over.health_allowance_php ?? row.health_allowance_php),
        t13Php: num(over.thirteenth_month_php ?? row.thirteenth_month_php),
        pddPhp: num(over.pdd_lunch_php ?? row.pdd_lunch_php),
        bonusPhp: num(over.bonus_php ?? row.bonus_php),
        miscItems: over.misc_items ?? row.misc_items ?? [],
      },
      // off_cycle is in the sum but never a target: those lines are their own
      // ledger and re-applied by the engine on every calculate.
      centavos(majorToMinor(num(over.off_cycle_php ?? row.off_cycle_php))),
    ),
  );

/**
 * Where a ±delta lands, as a set of column writes plus the recomputed net.
 *
 * Guards, in order of how expensive the mistake is:
 *  - a delta under a centavo is not a variance, and applying it would rewrite a
 *    row for nothing;
 *  - a negative delta that would push health allowance or 13th month below zero
 *    is refused, not clamped. HA pays in ONE anniversary period a year with no
 *    carry-forward (#84), so a clamp there quietly destroys a year of it. Misc
 *    takes deductions of any size.
 */
export const planAttribution = (
  row: AttributableRow,
  opts: { delta: number; target: AttributionTarget; label?: string; companyId?: string | null },
): AttributionPlan => {
  const delta = Math.round(opts.delta * 100) / 100;
  if (Math.abs(delta) < 0.01) {
    throw new Error('Nothing to attribute — Wise sent exactly the payroll amount.');
  }

  if (opts.target === 'misc') {
    const item: MiscItem = {
      kind: delta > 0 ? 'other_earns' : 'deduction',
      label: opts.label?.trim() || 'Reconcile adjustment',
      amount: Math.abs(delta),
      companyId: opts.companyId ?? null,
      source: RECONCILE_SOURCE,
    };
    const miscItems = [...(row.misc_items ?? []), item];
    return { miscItems, netPhp: netOf(row, { misc_items: miscItems }), prevValue: null, item };
  }

  const column =
    opts.target === 'health_allowance' ? 'health_allowance_php' : 'thirteenth_month_php';
  const prevValue = num(row[column]);
  const next = Math.round((prevValue + delta) * 100) / 100;
  if (next < 0) {
    throw new Error(
      `${opts.target === 'health_allowance' ? 'Health allowance' : '13th month'} would go negative (₱${prevValue.toLocaleString()} − ₱${Math.abs(delta).toLocaleString()}). Attribute it to Miscellaneous as a deduction instead.`,
    );
  }

  const over = { [column]: next } as Partial<AttributableRow>;
  return {
    ...(opts.target === 'health_allowance' ? { haPhp: next } : { t13Php: next }),
    netPhp: netOf(row, over),
    prevValue,
    item: null,
  };
};

/** What the audit event carries, and all an undo needs to read. */
export interface AttributionRecord {
  target: AttributionTarget;
  delta: number;
  prevValue: number | null;
  label?: string | null;
  companyId?: string | null;
}

/**
 * Reverse one attribution: restore the previous HA / 13th figure, or drop the
 * reconcile misc line it added. Without this a mis-picked target is permanent —
 * once net matches the transfer, the attribute action refuses to fire again.
 */
export const planUndo = (row: AttributableRow, rec: AttributionRecord): AttributionPlan => {
  if (rec.target === 'misc') {
    const items = row.misc_items ?? [];
    // Drop the LAST matching reconcile line — attributions append, so the last
    // one is the one this record wrote.
    const matches = (it: MiscItem): boolean =>
      it?.source === RECONCILE_SOURCE &&
      Math.abs(Number(it?.amount ?? 0) - Math.abs(rec.delta)) < 0.01 &&
      (rec.label == null || (it?.label ?? '') === rec.label);
    let idx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it && matches(it)) {
        idx = i;
        break;
      }
    }
    if (idx < 0) throw new Error('That reconcile line is no longer on this payment.');
    const miscItems = items.filter((_, i) => i !== idx);
    return {
      miscItems,
      netPhp: netOf(row, { misc_items: miscItems }),
      prevValue: null,
      item: null,
    };
  }

  const restored = num(rec.prevValue);
  const over =
    rec.target === 'health_allowance'
      ? ({ health_allowance_php: restored } as Partial<AttributableRow>)
      : ({ thirteenth_month_php: restored } as Partial<AttributableRow>);
  return {
    ...(rec.target === 'health_allowance' ? { haPhp: restored } : { t13Php: restored }),
    netPhp: netOf(row, over),
    prevValue: null,
    item: null,
  };
};
