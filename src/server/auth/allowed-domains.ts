import 'server-only';
import { isAllowedEmailForDomains, parseAllowedDomains } from '@/lib/auth/allowed-domains';
import { env } from '@/server/env';

/**
 * Server wiring for the admin-domain gate. The pure matching/parsing lives in
 * src/lib/auth/allowed-domains.ts (unit-tested); this module binds it to
 * ADMIN_SSO_ALLOWED_DOMAIN. Enforced in two places so the env var is real:
 *   - OAuth sign-in   → src/app/auth/callback/route.ts  (Google SSO is admin-only)
 *   - Admin creation  → src/server/actions/admin-manage.ts (owner adds an admin)
 *
 * Contractor portal logins are intentionally NOT gated here: contractors sign in
 * with email/password on personal-domain addresses and never take the admin SSO
 * path (their recovery links use the `email` provider, which the callback skips).
 */

/** Allowed admin work domains, lower-cased. Never empty — the env has a default. */
export const ALLOWED_ADMIN_DOMAINS: readonly string[] = parseAllowedDomains(
  env.ADMIN_SSO_ALLOWED_DOMAIN,
);

/** Per-address break-glass exceptions (e.g. an external owner). Empty by default. */
const ALLOWED_EXCEPTIONS: readonly string[] = [];

/** True when `email` is a syntactically valid address on an allowed admin domain. */
export function isAllowedAdminEmail(email: string): boolean {
  return isAllowedEmailForDomains(email, ALLOWED_ADMIN_DOMAINS, ALLOWED_EXCEPTIONS);
}
