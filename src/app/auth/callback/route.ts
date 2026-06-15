import { createServerSupabase } from '@/db/clients/server';
import { isOAuthSignIn } from '@/lib/auth/oauth-provider';
import { safeNext } from '@/lib/auth/safe-next';
import { isAllowedAdminEmail } from '@/server/auth/allowed-domains';
import { NextResponse } from 'next/server';

/**
 * OAuth / magic-link callback: exchange the auth code for a session cookie,
 * then land admins on the dashboard and contractors on the portal (the proxy
 * gate finishes the routing).
 *
 * Admin SSO domain gate: a federated (Google) sign-in IS the admin SSO path, so
 * its email must be on an allowed work domain (ADMIN_SSO_ALLOWED_DOMAIN). A
 * non-workspace account is signed out before it ever holds a usable session.
 * Contractor password-reset links also pass through here, but on the `email`
 * provider — they are deliberately NOT gated (contractors use personal-domain
 * addresses), so the gate keys off the auth provider, not the email alone.
 */

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeNext(url.searchParams.get('next'));
  if (code) {
    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(new URL('/login?error=oauth', url.origin));
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user && isOAuthSignIn(user) && !isAllowedAdminEmail(user.email ?? '')) {
      // Federated account outside the allowed work domain — revoke and bounce.
      await supabase.auth.signOut();
      return NextResponse.redirect(new URL('/login?error=domain', url.origin));
    }
  }
  return NextResponse.redirect(new URL(next, url.origin));
}
