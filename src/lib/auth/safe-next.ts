/**
 * Only accept a same-site, path-only redirect target — never a protocol-relative
 * (//host), backslash (/\host), or absolute (https://host) URL, which would turn
 * an auth redirect into an open redirect. Anything else collapses to '/'.
 *
 * Defence-in-depth: callers also resolve the result against the same-origin base
 * (new URL(next, origin)), but keeping the value path-only avoids relying solely
 * on URL-parsing quirks.
 */
export function safeNext(raw: string | null | undefined): string {
  const n = raw ?? '/';
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
}
