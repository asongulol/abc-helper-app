/**
 * Short client aliases for dense TABLE display — the full legal name
 * ("Ability Builders for Children, LLC") clutters grids. Matching is
 * case-insensitive substring on the full name; unmatched names fall back to the
 * full name. Add an entry here as each client is onboarded.
 *
 * Display-only: invoices, payslips, and stored data keep the full legal name.
 */
const CLIENT_ALIASES: ReadonlyArray<{ readonly match: string; readonly alias: string }> = [
  { match: 'ability builders', alias: 'ABC' },
  { match: '123 baby talks', alias: '123 BT' },
];

/** Full client name → short alias for tables (falls back to the full name). */
export const clientAlias = (name: string | null | undefined): string => {
  const full = (name ?? '').trim();
  if (!full) return '—';
  const lower = full.toLowerCase();
  for (const { match, alias } of CLIENT_ALIASES) {
    if (lower.includes(match)) return alias;
  }
  return full;
};
