/**
 * Which saved batch, if any, covers a period window.
 *
 * Exists so the server and the client agree. `/payroll` now ships the draft rows
 * with the HTML: the page resolves a batch, fetches its payments, and the shell
 * shows them without a round trip — but only while both sides pick the SAME
 * batch for the same window. Two hand-written `.find(...)` calls in two files
 * would hold that invariant by coincidence; this holds it by construction.
 *
 * Matches the stored window verbatim rather than re-deriving it. Off-cycle
 * batches are stored with start === end and would not survive a trip through
 * periodFor().
 */
export const batchForWindow = <T extends { periodStart: string; periodEnd: string }>(
  batches: readonly T[],
  start: string,
  end: string,
): T | null => batches.find((b) => b.periodStart === start && b.periodEnd === end) ?? null;
