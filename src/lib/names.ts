/**
 * Contractor-name matching keys, ported from the legacy app
 * (app/index.html ~4313 `nameTokens` / `nameKey` / `looseKey`).
 *
 * Used to attribute time entries whose `worker_id` is null by their
 * `source_name` (Hubstaff display name, CSV imports). The strict key is
 * order-insensitive over ALL tokens; the loose key keeps only first+last so a
 * record with an extra middle name still matches.
 */

/**
 * Canonical worker display name: first + middle + last, blanks skipped.
 * One helper so every screen shows the same person the same way (was inlined
 * a dozen places; the roster table used to drop the middle name — #037).
 */
export const fullName = (w: {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
}): string => [w.firstName, w.middleName, w.lastName].filter(Boolean).join(' ').trim();

export const nameTokens = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  const s = String(raw)
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // strip accents
    .replace(/[.,]/g, ' ')
    .replace(/\bMa\b/gi, 'Maria')
    .replace(/\b(jr|sr|ii|iii|iv|n)\b/gi, ' ');
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => x.toLowerCase());
};

/** STRICT key: all tokens, sorted — word order / extra middle names don't break a match. */
export const nameKey = (raw: string | null | undefined): string => {
  const t = nameTokens(raw);
  return t.length ? [...t].sort().join(' ') : '';
};

/** LOOSE key: first + last token only (legacy fallback matching). */
export const looseKey = (raw: string | null | undefined): string => {
  const t = nameTokens(raw);
  if (t.length === 0) return '';
  if (t.length === 1) return t[0] as string;
  return `${t[0]} ${t[t.length - 1]}`;
};
