/**
 * Display formatting helpers — pure and client-safe (usable in Server and
 * Client Components alike; no 'server-only').
 *
 * `money` matches the legacy admin app exactly: "PHP 12,345.67" / "$123.45",
 * and an em dash for missing values. A fixed `en-US` locale is used instead of
 * the legacy `undefined` (browser locale) so server-rendered HTML always
 * matches client hydration.
 */

export type Currency = 'PHP' | 'USD';

const NUMBER_2DP = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const DATETIME_FMT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

/** "PHP 12,345.67" / "$123.45" / "—" for null (legacy `money()`). */
export const money = (n: number | null | undefined, cur: Currency = 'PHP'): string => {
  if (n == null) return '—';
  return (cur === 'USD' ? '$' : 'PHP ') + NUMBER_2DP.format(n);
};

/** "Jun 12, 2026" from an ISO date or timestamp; "—" for empty/invalid. */
export const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : `${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return DATE_FMT.format(d);
};

/** "Jun 12, 2026, 6:48 PM" (UTC) from an ISO timestamp; "—" for empty/invalid. */
export const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return DATETIME_FMT.format(d);
};

/** "82.5h" — hours with up to 2 decimals, trailing zeros trimmed; "—" for null. */
export const hours = (n: number | null | undefined): string => {
  if (n == null || Number.isNaN(n)) return '—';
  const rounded = Math.round(n * 100) / 100;
  return `${rounded.toLocaleString('en-US', { maximumFractionDigits: 2 })}h`;
};

/**
 * Convert integer centavos (the money-lib minor unit) to PHP major units for
 * display: `money(centavosToPhp(v), 'PHP')`.
 */
export const centavosToPhp = (c: number): number => c / 100;
