/**
 * Wise batch-upload CSV builder — pure, no DB access.
 *
 * Produces the EXACT Wise "all recipients" batch-upload template (10 columns),
 * keyed by the stable recipient UUID. Port of the legacy `downloadWiseBatch`
 * (abc-work-app index.html ~9866).
 *
 * Wise-only by construction: only rows whose payout method is `wise` are
 * eligible, and rows Wise would reject — no recipient UUID, or a net of zero —
 * are returned in `dropped` with a reason so the caller can warn rather than
 * emit a file Wise rejects. BPI / gcash / paymaya / paypal are never included.
 */

// Shared with the other two CSV builders — quoting + formula-injection guard.
// Wise's importer is unaffected by injection, but the escape is numeric-safe so
// the amount / UUID columns come out byte-identical to the template.
import { escapeCsvField } from '@/lib/payroll/bank-export';

export type WiseBatchRow = {
  name: string;
  email: string | null;
  /** PHP major units (from the DB). */
  netPhp: number;
  payoutMethod: string | null;
  /** Stable Wise recipient UUID; null when the contractor has none on file. */
  wiseRecipientUuid: string | null;
};

const WISE_HEADER = [
  'recipientId',
  'name',
  'recipientEmail',
  'recipientDetail',
  'sourceCurrency',
  'targetCurrency',
  'amountCurrency',
  'amount',
  'paymentReference',
  'receiverType',
] as const;

/** Whole numbers have no trailing .00; cents preserved (matches legacy `fmtAmt`). */
const fmtAmount = (n: number): string => {
  const v = Math.round(Number(n) * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
};

/** A Wise row that can't be uploaded, with the reason to show the admin. */
export type DroppedWiseRow = WiseBatchRow & {
  reason: 'no Wise recipient UUID' | 'no amount';
};

export interface WiseBatchResult {
  csv: string;
  filename: string;
  /** Wise rows with a UUID and a positive net — the ones written to the CSV. */
  included: WiseBatchRow[];
  /** Wise rows Wise would reject, each carrying why. */
  dropped: DroppedWiseRow[];
}

export const buildWiseBatch = (
  rows: readonly WiseBatchRow[],
  opts: {
    periodStart: string;
    periodEnd: string;
    sourceCurrency?: string;
    targetCurrency?: string;
  },
): WiseBatchResult => {
  const src = opts.sourceCurrency ?? 'USD';
  const tgt = opts.targetCurrency ?? 'PHP';
  // `amount` below is netPhp with amountCurrency='target' — a PESO figure. Any
  // other target would have Wise read ₱50,000 as $50,000 (~58× overpay) on every
  // row. Payouts are PHP-only (docs/money-core-spec.md), so refuse rather than
  // emit a file that pays the wrong currency.
  if (tgt !== 'PHP') throw new Error(`Wise batch target currency must be PHP (got ${tgt}).`);

  // Only Wise rows are eligible for the batch upload (never BPI / others).
  const wiseRows = rows.filter((r) => r.payoutMethod === 'wise');
  // RP-60: a zero net writes `amount` 0 and Wise rejects the row — sometimes the
  // whole upload, taking the other contractors' payments with it. The API path
  // already skips these (`triageDraftRow`: "no amount"); the manual file didn't.
  // Lock refuses a null or negative net but not a zero one.
  const included = wiseRows.filter((r) => !!r.wiseRecipientUuid && r.netPhp > 0);
  const dropped: DroppedWiseRow[] = wiseRows
    .filter((r) => !r.wiseRecipientUuid || !(r.netPhp > 0))
    .map((r) => ({
      ...r,
      reason: r.wiseRecipientUuid ? ('no amount' as const) : ('no Wise recipient UUID' as const),
    }));

  const ref = `Payroll ${opts.periodEnd}`.trim();
  const lines = included.map((r) =>
    [
      r.wiseRecipientUuid ?? '',
      r.name,
      r.email ?? '',
      '', // recipientDetail — Wise fills it from recipientId
      src,
      tgt,
      'target',
      fmtAmount(r.netPhp),
      ref,
      'PERSON',
    ]
      .map((f) => escapeCsvField(String(f)))
      .join(','),
  );

  const csv = [WISE_HEADER.join(','), ...lines].join('\n');
  const filename = `wise_batch_${opts.periodStart}_to_${opts.periodEnd}.csv`;
  return { csv, filename, included, dropped };
};
