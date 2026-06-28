/**
 * Wise batch-upload CSV builder — pure, no DB access.
 *
 * Produces the EXACT Wise "all recipients" batch-upload template (10 columns),
 * keyed by the stable recipient UUID. Port of the legacy `downloadWiseBatch`
 * (abc-work-app index.html ~9866).
 *
 * Wise-only by construction: only rows whose payout method is `wise` are
 * eligible, and rows missing a Wise recipient UUID can't be uploaded — they are
 * returned in `dropped` so the caller can warn rather than emit a file Wise
 * would reject. BPI / gcash / paymaya / paypal rows are never included.
 */

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

const escapeCsvField = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export interface WiseBatchResult {
  csv: string;
  filename: string;
  /** Wise rows with a UUID — the ones written to the CSV. */
  included: WiseBatchRow[];
  /** Wise rows dropped because they have no recipient UUID. */
  dropped: WiseBatchRow[];
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

  // Only Wise rows are eligible for the batch upload (never BPI / others).
  const wiseRows = rows.filter((r) => r.payoutMethod === 'wise');
  const included = wiseRows.filter((r) => !!r.wiseRecipientUuid);
  const dropped = wiseRows.filter((r) => !r.wiseRecipientUuid);

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
