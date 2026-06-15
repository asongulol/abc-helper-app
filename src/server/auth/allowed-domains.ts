import 'server-only';
import { env } from '@/server/env';

/**
 * Single source of truth for which email domains may hold an admin account.
 *
 * Parsed from ADMIN_SSO_ALLOWED_DOMAIN (comma-separated for multiple domains).
 * Enforced in two places so the env var is no longer decorative:
 *   - OAuth sign-in   → src/app/auth/callback/route.ts  (Google SSO is admin-only)
 *   - Admin creation  → src/server/actions/admin-manage.ts (owner adds an admin)
 *
 * Contractor portal logins are intentionally NOT gated here: contractors sign in
 * with email/password on personal-domain addresses and never take the admin SSO
 * path (their recovery links use the `email` provider, which the callback skips).
 */

/** Allowed admin work domains, lower-cased. Never empty — the env has a default. */
export const ALLOWED_ADMIN_DOMAINS: readonly string[] = env.ADMIN_SSO_ALLOWED_DOMAIN.split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

/** Per-address break-glass exceptions (e.g. an external owner). Empty by default. */
const ALLOWED_EXCEPTIONS: readonly string[] = [];

/** True when `email` is a syntactically valid address on an allowed admin domain. */
export function isAllowedAdminEmail(email: string): boolean {
  const e = String(email ?? '')
    .trim()
    .toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false;
  if (ALLOWED_EXCEPTIONS.includes(e)) return true;
  const domain = e.split('@')[1] ?? '';
  return ALLOWED_ADMIN_DOMAINS.includes(domain);
}
