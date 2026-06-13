import { createServerSupabase } from '@/db/clients/server';
import { NextResponse } from 'next/server';

/**
 * OAuth / magic-link callback: exchange the auth code for a session cookie,
 * then land admins on the dashboard and contractors on the portal (the proxy
 * gate finishes the routing).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/';
  if (code) {
    const supabase = await createServerSupabase();
    await supabase.auth.exchangeCodeForSession(code);
  }
  return NextResponse.redirect(new URL(next, url.origin));
}
