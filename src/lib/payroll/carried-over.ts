/**
 * Detect a "carried-over" payroll draft.
 *
 * A legacy sibling app that shares this production DB seeds a new regular period
 * by cloning the PREVIOUS period's payment rows (same gross/net/hours/misc), so
 * the recalculate screen shows last period's amounts until this app recomputes
 * from the period's own tracked hours. That is misleading — the figures look
 * final but are stale.
 *
 * We flag it when a strong majority of the current draft's rows are byte-identical
 * to the previous period's rows. This is only a BACKSTOP to the durable
 * `recalculate` audit-event guard (see `shouldAutoRecalcDraft`): its real job is
 * to ensure that once the draft carries recomputed OR hand-edited figures it no
 * longer matches the prior period, so the one-time auto-recalc can never re-run
 * and overwrite later changes (which would pay contractors the wrong amount).
 */
export type ClonableRow = {
  workerId: string;
  grossPhp: number | null;
  netPhp: number | null;
  workedHours: number;
  miscItems: unknown;
};

export const isCarriedOverClone = (
  current: readonly ClonableRow[],
  previous: readonly ClonableRow[],
): boolean => {
  if (current.length === 0 || previous.length === 0) return false;
  const prev = new Map(previous.map((r) => [r.workerId, r]));
  let matched = 0;
  for (const c of current) {
    const p = prev.get(c.workerId);
    if (
      p &&
      p.grossPhp === c.grossPhp &&
      p.netPhp === c.netPhp &&
      p.workedHours === c.workedHours &&
      JSON.stringify(p.miscItems) === JSON.stringify(c.miscItems)
    )
      matched++;
  }
  // ponytail: ≥60% byte-match = carried over. Loose on purpose — the audit-event
  // once-guard is authoritative; this only needs to read false once real figures
  // or edits appear so auto-recalc stays a one-shot.
  return matched / current.length >= 0.6;
};
