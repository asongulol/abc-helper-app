'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { Mark } from '@/components/brand/Mark';
import { ToastProvider } from '@/components/ui';
import { createBrowserSupabase } from '@/db/clients/browser';

interface Props {
  workerName: string;
  onboarded: boolean;
  /** Email shown under the workspace title in the header. */
  email?: string;
  /** Count of documents needing the contractor's attention (nav badge). */
  docsBadge?: number;
  children: ReactNode;
}

interface NavItem {
  href: string;
  label: string;
  icon: string;
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/portal', label: 'Home', icon: '🏠', exact: true },
  { href: '/portal/onboarding', label: 'Onboarding', icon: '📋' },
  { href: '/portal/statements', label: 'Pay slips', icon: '₱' },
  { href: '/portal/time', label: 'Time', icon: '⏱' },
  { href: '/portal/sessions', label: 'Sessions', icon: '🗓' },
  { href: '/portal/docs', label: 'Docs', icon: '📄' },
  { href: '/portal/profile', label: 'Profile', icon: '👤' },
];

export const PortalShell = ({ workerName, onboarded, email, docsBadge = 0, children }: Props) => {
  const pathname = usePathname();
  const [signingOut, setSigningOut] = useState(false);
  // Desktop sidebar: collapse state (persisted), mirroring the legacy portal.
  const [navCollapsed, setNavCollapsed] = useState(false);

  useEffect(() => {
    try {
      setNavCollapsed(localStorage.getItem('portal_nav_collapsed') === '1');
    } catch {
      // ignore (private mode / SSR)
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('portal_nav_collapsed', navCollapsed ? '1' : '0');
    } catch {
      // ignore
    }
  }, [navCollapsed]);

  // Pin the desktop sidebar below the full-width header using its real height.
  useEffect(() => {
    const set = () => {
      const t = document.querySelector('.portal-shell .top');
      if (t instanceof HTMLElement) {
        document.documentElement.style.setProperty('--ptop-h', `${t.offsetHeight}px`);
      }
    };
    set();
    window.addEventListener('resize', set);
    return () => window.removeEventListener('resize', set);
  }, []);

  const isActive = (item: NavItem) =>
    item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`);

  const signOut = async () => {
    setSigningOut(true);
    try {
      // Local scope: sign out this device only, not every session the contractor
      // has open elsewhere (a global sign-out killed their phone silently). (#031)
      await createBrowserSupabase().auth.signOut({ scope: 'local' });
    } finally {
      window.location.href = '/portal/login';
    }
  };

  return (
    <ToastProvider>
      <div className={`portal portal-shell${navCollapsed ? ' nav-collapsed' : ''}`}>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <div className="top">
          <span
            style={{
              display: 'inline-flex',
              lineHeight: 0,
              marginRight: 12,
            }}
          >
            <Mark height={26} priority />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="ws-title">{workerName ? `${workerName}'s Workspace` : 'Workspace'}</h1>
            {email && <small>{email}</small>}
          </div>
          <button
            type="button"
            className="btn ghost"
            style={{ padding: '6px 10px', fontSize: 13 }}
            onClick={signOut}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>

        <main className={`wrap${pathname === '/portal' ? ' home' : ''}`} id="main">
          {children}
        </main>

        <div
          className="pbuild"
          style={{
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 11,
            padding: '10px 0 84px',
          }}
        >
          Aaron Anderson E.H.S. LLC
        </div>

        <nav className="tabs no-print" aria-label="Portal sections">
          {NAV_ITEMS.map((item) => {
            // Onboarding is the mirror image of the other sub-pages: visible only
            // until the contractor finishes onboarding, then it hides again.
            const hidden =
              item.href === '/portal/onboarding'
                ? onboarded
                : !onboarded && item.href !== '/portal';
            if (hidden) return null;
            const active = isActive(item);
            const showBadge = item.href === '/portal/docs' && docsBadge > 0;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? 'on' : undefined}
                aria-current={active ? 'page' : undefined}
              >
                <span className="ic" aria-hidden="true">
                  {showBadge ? (
                    <span style={{ position: 'relative', display: 'inline-block' }}>
                      {item.icon}
                      <span
                        role="img"
                        aria-label={`${docsBadge} to upload`}
                        style={{
                          position: 'absolute',
                          top: -6,
                          right: -11,
                          background: 'var(--bad)',
                          color: '#fff',
                          borderRadius: 999,
                          fontSize: 10,
                          fontWeight: 800,
                          minWidth: 15,
                          height: 15,
                          lineHeight: '15px',
                          textAlign: 'center',
                          padding: '0 3px',
                          boxShadow: '0 0 0 2px #fff',
                        }}
                      >
                        {docsBadge}
                      </span>
                    </span>
                  ) : (
                    item.icon
                  )}
                </span>
                {item.label}
              </Link>
            );
          })}
          <button
            type="button"
            className="nav-collapse"
            onClick={() => setNavCollapsed((c) => !c)}
            aria-label={navCollapsed ? 'Expand menu' : 'Collapse menu'}
            title={navCollapsed ? 'Expand' : 'Collapse'}
          >
            <span className="ic" aria-hidden="true">
              {navCollapsed ? '»' : '«'}
            </span>
            Collapse
          </button>
        </nav>
      </div>
    </ToastProvider>
  );
};
