import type { Metadata } from 'next';
import { PortalLoginForm } from '@/components/auth/PortalLoginForm';
import { Logo } from '@/components/brand/Logo';
import { portalAccessEnded } from '@/server/auth/worker';

export const metadata: Metadata = { title: 'Sign in — Contractor Portal' };

export default async function PortalLoginPage() {
  // The (authed) layout bounces a departed-and-paid contractor back here; this is
  // where that lands, so the page has to be able to tell them apart from a stranger.
  // Anonymous visitors (almost everyone here) cost one getUser and stop there.
  const accessEnded = await portalAccessEnded();

  return (
    <div className="portal">
      <div className="wrap">
        <div style={{ textAlign: 'center', margin: '32px 0 8px' }}>
          <Logo height={52} priority />
          <h2 style={{ margin: '10px 0 0' }}>Contractor Portal</h2>
          {!accessEnded && <p className="sub">Sign in to view your pay, time, and documents.</p>}
        </div>
        <PortalLoginForm accessEnded={accessEnded} />
        <p className="sub" style={{ textAlign: 'center' }}>
          Trouble signing in? Contact your payroll admin.
        </p>
      </div>
    </div>
  );
}
