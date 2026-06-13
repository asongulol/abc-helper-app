/**
 * Client-side editable-row net recomposition — same formula as the engine:
 *   net = gross + ha + t13 + pdd + bonus + miscTotal(misc_items)
 *
 * All values arrive as PHP major units (number), are converted to integer
 * centavos, summed, and returned as centavos. Callers display via
 * centavosToPhp + money().
 *
 * Pure: no DB, no React, no server-only.
 */

import { type Centavos, addMinor, centavos } from '@/lib/money';
import { miscTotal } from '@/lib/pay/calc';
import type { MiscItem } from '@/lib/pay/calc';
import { phpToCentavos } from '@/lib/payroll/mappers';

export type EditableRowValues = {
  grossPhp: number | null;
  haPhp: number;
  t13Php: number;
  pddPhp: number;
  bonusPhp: number;
  miscItems: readonly MiscItem[];
};

/**
 * Recompute net centavos from a row's components.
 * Returns null when gross is null (no rate).
 */
export const recomputeNetCentavos = (row: EditableRowValues): Centavos | null => {
  if (row.grossPhp == null) return null;
  const grossC = phpToCentavos(row.grossPhp) ?? (centavos(0) as Centavos);
  const haC = phpToCentavos(row.haPhp) ?? (centavos(0) as Centavos);
  const t13C = phpToCentavos(row.t13Php) ?? (centavos(0) as Centavos);
  const pddC = phpToCentavos(row.pddPhp) ?? (centavos(0) as Centavos);
  const bonusC = phpToCentavos(row.bonusPhp) ?? (centavos(0) as Centavos);
  const miscC = miscTotal(row.miscItems);
  return addMinor(addMinor(addMinor(addMinor(addMinor(grossC, haC), t13C), pddC), bonusC), miscC);
};
