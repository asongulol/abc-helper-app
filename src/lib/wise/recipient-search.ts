/**
 * Match a free-text search term against a saved Wise recipient's name/email.
 *
 * There is no public Wise endpoint that searches by Wisetag, so the "By name /
 * tag" lookup filters the recipient list client-side. Matching the space-
 * stripped name lets a Wisetag like "@leatheresanuevab" find the recipient
 * saved as "Lea Theresa Nueva B". A Wisetag unrelated to the legal name won't
 * match — that case uses the numeric "By recipient ID" route instead.
 */
export function recipientMatchesTerm(name: string, email: string | null, term: string): boolean {
  const t = term.trim().replace(/^@/, '').toLowerCase();
  if (!t) return false;
  const n = name.toLowerCase();
  return (
    n.includes(t) || n.replace(/\s+/g, '').includes(t) || (email ?? '').toLowerCase().includes(t)
  );
}
