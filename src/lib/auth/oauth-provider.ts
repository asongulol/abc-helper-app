/**
 * Pure provider check for the admin SSO domain gate. A federated (OAuth) sign-in
 * IS the admin SSO path and must be domain-gated; the `email` provider (password
 * + recovery links) must NOT be, so contractors aren't locked out. Kept pure +
 * structurally typed so it's unit-testable without the Supabase User type.
 */

/** Minimal shape of a Supabase auth user needed to classify the provider. */
export interface OAuthUserLike {
  app_metadata?: { provider?: string; providers?: string[] } | null;
  identities?: ReadonlyArray<{ provider?: string }> | null;
}

/** True for a federated identity (anything other than the `email` provider). */
export function isOAuthSignIn(user: OAuthUserLike): boolean {
  const provider = user.app_metadata?.provider;
  if (provider && provider !== 'email') return true;
  const providers = user.app_metadata?.providers;
  if (Array.isArray(providers) && providers.some((p) => p && p !== 'email')) return true;
  return (user.identities ?? []).some((i) => i.provider && i.provider !== 'email');
}
