import { createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';
import type { Database } from '@/db/types';

/**
 * Auth gate (Next.js proxy convention, formerly middleware).
 *  1. Keeps the Supabase session fresh (cookie pass-through).
 *  2. Routes by audience: admins own the admin area (everything except
 *     /portal), contractors own /portal. Each audience is bounced to its own
 *     login page; neither can wander into the other's area.
 *
 * Anon client + RLS only — no service-role secret in the edge bundle.
 */

const ADMIN_LOGIN = '/login';
const PORTAL_LOGIN = '/portal/login';
const PUBLIC_PATHS = new Set([ADMIN_LOGIN, PORTAL_LOGIN, '/auth/callback']);

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.next({ request });
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return response;
  // Cron-invoked routes have no Supabase session; they self-gate via x-cron-secret
  // (see src/server/cron.ts), so skip the audience auth gate for them.
  if (pathname.startsWith('/api/cron/')) return response;

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPortal = pathname === '/portal' || pathname.startsWith('/portal/');

  if (!user) {
    return NextResponse.redirect(new URL(isPortal ? PORTAL_LOGIN : ADMIN_LOGIN, request.url));
  }

  // Role resolution (RLS lets each user see only their own membership rows).
  const { data: adminRow } = await supabase
    .from('admin_users')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (isPortal) {
    if (adminRow) return response; // admins may preview the portal
    const { data: login } = await supabase
      .from('contractor_logins')
      .select('worker_id')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    if (!login) {
      await supabase.auth.signOut();
      return NextResponse.redirect(new URL(PORTAL_LOGIN, request.url));
    }
    return response;
  }

  if (!adminRow) {
    // A contractor in the admin area → send to their portal home.
    const { data: login } = await supabase
      .from('contractor_logins')
      .select('worker_id')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    if (login) return NextResponse.redirect(new URL('/portal', request.url));
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL(ADMIN_LOGIN, request.url));
  }

  return response;
}

export const config = {
  // Gate everything except static assets and Next internals.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|svg|jpg|webp|ico)$).*)'],
};
