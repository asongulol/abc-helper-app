/**
 * Match a free-text search term against a Wise bank recipient's name/email.
 *
 * Backs the "By name" lookup, which filters the recipient list client-side.
 * Matching the space-stripped name lets a run-together query like
 * "leatheresanueva" find a recipient saved as "Lea Theresa Nueva B"; a leading
 * "@" is ignored so a pasted Wisetag still matches on the underlying name.
 */
export function recipientMatchesTerm(name: string, email: string | null, term: string): boolean {
  const t = term.trim().replace(/^@/, '').toLowerCase();
  if (!t) return false;
  const n = name.toLowerCase();
  return (
    n.includes(t) || n.replace(/\s+/g, '').includes(t) || (email ?? '').toLowerCase().includes(t)
  );
}
