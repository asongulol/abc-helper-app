/**
 * Editable-row edit semantics for the Calculate screen — what a manual edit
 * means, beside `row-net.ts` which says what a row's net comes to.
 *
 * These lived inside `PayrollShell.tsx`, so testing them pulled the component,
 * which pulls the server actions, which validate Supabase env at module load —
 * the tests had to `vi.stubEnv` three fake credentials to import two pure
 * functions. Pure: no DB, no React, no server-only.
 */

import type { MiscItem } from '@/lib/pay/calc';

/**
 * What the Misc modal hands back on save. `t13Php: null` is its "cleared field"
 * signal — the field's own label previews the computed 13th month, so clearing
 * it means revert to that, not ₱0 (RP-21).
 */
export type MiscEdit = {
  haPhp: number;
  t13Php: number | null;
  pddPhp: number;
  bonusPhp: number;
  miscItems: MiscItem[];
};

/**
 * Does this row carry manual work that a Recalculate would destroy?
 * A manually set 13th month counts (RP-24): it lives in its own column rather
 * than in `miscItems`, so the old check let a recalc wipe it with no confirm.
 */
export const hasManualAdjustments = (r: {
  overridden: boolean;
  haPhp: number;
  pddPhp: number;
  bonusPhp: number;
  t13Php: number;
  computedT13Php: number;
  miscItems: readonly MiscItem[];
}): boolean =>
  r.overridden ||
  r.haPhp > 0 ||
  r.pddPhp > 0 ||
  r.bonusPhp > 0 ||
  r.miscItems.length > 0 ||
  r.t13Php !== r.computedT13Php;

/** Row patch for a Misc modal save — see `MiscEdit` on the null 13th month. */
export const miscPatch = (
  row: { computedT13Php: number },
  payload: MiscEdit,
): {
  haPhp: number;
  t13Php: number;
  pddPhp: number;
  bonusPhp: number;
  miscItems: MiscItem[];
} => ({
  haPhp: payload.haPhp,
  t13Php: payload.t13Php ?? row.computedT13Php,
  pddPhp: payload.pddPhp,
  bonusPhp: payload.bonusPhp,
  miscItems: payload.miscItems,
});
