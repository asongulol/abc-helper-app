/**
 * Client-side editable-row net recomposition — delegates to composeNet, the
 * engine's own formula (incl. its null rule: no gross ⇒ no net).
 *
 * All values arrive as PHP major units (number), are converted to integer
 * centavos, summed, and returned as centavos. Callers display via
 * centavosToPhp + money(). `offCyclePhp` is the durable off-cycle ledger total
 * carried on the row — included so editing misc never silently drops it.
 *
 * Pure: no DB, no React, no server-only.
 */

import { type Centavos, centavos } from '@/lib/money';
import type { MiscItem } from '@/lib/pay/calc';
import { composeNet, miscTotal } from '@/lib/pay/calc';
import { phpToCentavos } from '@/lib/payroll/mappers';

export type EditableRowValues = {
  grossPhp: number | null;
  haPhp: number;
  t13Php: number;
  pddPhp: number;
  bonusPhp: number;
  miscItems: readonly MiscItem[];
  /** Durable off-cycle ledger total carried on the row (default 0). */
  offCyclePhp?: number;
};

/**
 * Recompute net centavos from a row's components.
 * Returns null when gross is null (no rate).
 */
export const recomputeNetCentavos = (row: EditableRowValues): Centavos | null =>
  composeNet(phpToCentavos(row.grossPhp), {
    healthAllowance: phpToCentavos(row.haPhp) ?? centavos(0),
    thirteenth: phpToCentavos(row.t13Php) ?? centavos(0),
    pddLunch: phpToCentavos(row.pddPhp) ?? centavos(0),
    bonus: phpToCentavos(row.bonusPhp) ?? centavos(0),
    misc: miscTotal(row.miscItems),
    offCycle: phpToCentavos(row.offCyclePhp ?? 0) ?? centavos(0),
  });
