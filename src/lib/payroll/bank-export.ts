/**
 * BPI/bank CSV export builder — pure, no DB access.
 *
 * Generates a CSV suitable for BPI or generic bank batch upload with:
 *   Name, Bank (placeholder), Account (placeholder), Amount PHP (2 dp)
 *
 * Uses centavos as the input unit and formats to PHP major units (2 dp)
 * exactly as stored — no float accumulation.
 */

export type BankExportRow = {
  name: string;
  /** PHP major units (from the DB). */
  netPhp: number;
  payoutMethod: string | null;
};

const escapeCsvField = (v: string): string => {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
};

/**
 * Build a BPI/bank CSV for the given payment rows.
 * Filters to non-wise rows (or all rows when `all=true`).
 * Returns the CSV string and filename.
 */
export const buildBankExport = (
  rows: readonly BankExportRow[],
  opts: { periodStart: string; periodEnd: string; includeWise?: boolean },
): { csv: string; filename: string } => {
  const exportRows = opts.includeWise ? rows : rows.filter((r) => r.payoutMethod !== 'wise');

  const header = ['Name', 'Bank', 'Account', 'Amount (PHP)'].join(',');
  const lines = exportRows.map((r) => {
    const amountPhp = r.netPhp.toFixed(2);
    return [
      escapeCsvField(r.name),
      escapeCsvField(r.payoutMethod ?? ''),
      '', // account placeholder — not stored in this system
      amountPhp,
    ].join(',');
  });

  const csv = [header, ...lines].join('\n');
  const filename = `payroll-${opts.periodStart}-to-${opts.periodEnd}.csv`;
  return { csv, filename };
};

/**
 * Trigger a browser download of the CSV string.
 * Call from a client component only.
 */
export const downloadCsv = (csv: string, filename: string): void => {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
