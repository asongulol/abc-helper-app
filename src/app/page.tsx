import { redirect } from 'next/navigation';

/**
 * Authenticated home is the Overview dashboard (legacy default tab).
 *
 * The bare-origin recovery-code guard lives in src/proxy.ts, not here: an
 * unauthenticated request to `/` never reaches this component at all (the
 * proxy bounces it to /login first), and a recovery code always arrives
 * pre-session, so that's the only place a `?code=` could ever land.
 */
export default function Home() {
  redirect('/overview');
}
