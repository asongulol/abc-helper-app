/**
 * Pure admin-domain matching — no env, no server-only — so the security boundary
 * is unit-testable. The server wrapper (src/server/auth/allowed-domains.ts) wires
 * these to ADMIN_SSO_ALLOWED_DOMAIN and to the OAuth callback + admin creation.
 */

/** Parse a comma-separated domain list into trimmed, lower-cased, non-empty entries. */
export function parseAllowedDomains(raw: string): string[] {
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True when `email` is a syntactically valid address whose EXACT domain is in
 * `domains` (or the address is an explicit exception). Exact-match only — a
 * subdomain (sub.abckidsny.com) or look-alike (evil-abckidsny.com,
 * abckidsny.com.evil.com) is rejected.
 */
export function isAllowedEmailForDomains(
  email: string,
  domains: readonly string[],
  exceptions: readonly string[] = [],
): boolean {
  const e = String(email ?? '')
    .trim()
    .toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false;
  // Normalize exceptions the same way as the email so a mixed-case break-glass
  // entry can't silently never match.
  if (exceptions.some((x) => x.trim().toLowerCase() === e)) return true;
  const domain = e.split('@')[1] ?? '';
  return domains.includes(domain);
}
