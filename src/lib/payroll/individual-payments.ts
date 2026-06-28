/**
 * Individual payments CSV builder — pure, no DB access.
 *
 * A per-contractor breakdown of EVERY payment in the batch (all methods,
 * including BPI), for manual/individual payments and record-keeping. Port of the
 * legacy `downloadIndividual` (abc-work-app index.html ~9879).
 */

export type IndividualPaymentRow = {
  name: string;
  payoutMethod: string | null;
  wiseRecipientId: number | null;
  email: string | null;
  /** PHP major units (from the DB). */
  netPhp: number;
};

const escapeCsvField = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export interface IndividualPaymentsResult {
  csv: string;
  filename: string;
  count: number;
}

export const buildIndividualPayments = (
  rows: readonly IndividualPaymentRow[],
  opts: { payDate: string | null; periodStart: string; periodEnd: string },
): IndividualPaymentsResult => {
  const header = [
    'Contractor',
    'Method',
    'Wise recipient id',
    'Email',
    'Amount PHP',
    'Pay date',
    'Period',
  ];
  const period = `${opts.periodStart}–${opts.periodEnd}`;
  const lines = rows.map((r) =>
    [
      r.name,
      r.payoutMethod ?? '',
      r.wiseRecipientId != null ? String(r.wiseRecipientId) : '',
      r.email ?? '',
      r.netPhp.toFixed(2),
      opts.payDate ?? '',
      period,
    ]
      .map((f) => escapeCsvField(String(f)))
      .join(','),
  );
  const csv = [header.join(','), ...lines].join('\n');
  const filename = `payments_${opts.periodStart}_to_${opts.periodEnd}.csv`;
  return { csv, filename, count: rows.length };
};
