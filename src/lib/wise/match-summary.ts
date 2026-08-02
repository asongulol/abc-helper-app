/**
 * Turn a backfill-match run into the line the operator actually sees.
 *
 * The matcher has ten outcomes; the UI used to report two of them ("matched" and
 * "no transfer found") and called everything else a green success. A run where
 * every row came back ambiguous, or with no recipient on file, or failed its DB
 * write, said "Matched 0 transfer(s)." in success green and left the table
 * unchanged — indistinguishable from a no-op. Every outcome is named here.
 *
 * Note both variance outcomes DO write the transfer id (see decideMatch), so
 * they count as linked — they're flagged, not skipped.
 */

import type { UnlinkedPayment } from './types';

export interface MatchTally {
  /** Rows the matcher looked at. */
  scanned: number;
  /** Linked cleanly. */
  matched: number;
  /** Linked, but the Wise amount differs from the stored net. */
  variances: number;
  /** Several Wise transfers fit — left alone rather than guess. */
  ambiguous: number;
  /** Contractor has no Wise recipient on their profile. */
  noRecipient: number;
  /** No Wise transfer for that recipient near the payment date. */
  noTransfer: number;
  /** Matched, but the write back to payments failed. */
  dbWriteFailed: number;
  /** Row holds a transfer that never paid: a cancelled ghost, an unfunded draft,
   *  or an id missing from the pulled history. The link is not evidence. */
  unpaidLink: number;
  /** The transfer that fit says, in its own reference, that it paid a different
   *  period — the previous batch sitting in this period's window. */
  wrongPeriod: number;
}

/** What wiseMatch hands back: the tally plus the rows to act on. */
export interface MatchOutcomeReport extends MatchTally {
  unlinked: UnlinkedPayment[];
}

export interface MatchSummary {
  text: string;
  tone: 'success' | 'warn' | 'info';
}

export const matchSummary = (t: MatchTally): MatchSummary => {
  if (t.scanned === 0) {
    return {
      text: 'Nothing to match — every Wise payment here already has a transfer ID.',
      tone: 'info',
    };
  }

  const linked = t.matched + t.variances;
  const skipped = [
    [t.ambiguous, 'ambiguous (several Wise transfers fit)'],
    [t.noRecipient, 'with no Wise recipient on file'],
    [t.noTransfer, 'with no Wise transfer near the payment date'],
    [t.dbWriteFailed, 'that failed to save'],
    [t.unpaidLink, 'holding a transfer that never paid (the real one is likely unclaimed)'],
    [t.wrongPeriod, 'whose only candidate names a different period in Wise'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, why]) => `${n} ${why}`)
    .join(', ');

  const head =
    linked > 0
      ? `Linked ${linked} of ${t.scanned} payment(s)` +
        (t.variances > 0 ? `, ${t.variances} with an amount difference to review` : '')
      : `Linked none of the ${t.scanned} payment(s) scanned`;

  return {
    text: `${head}${skipped ? ` — ${skipped}` : ''}.`,
    tone: linked === 0 || t.variances > 0 ? 'warn' : 'success',
  };
};
