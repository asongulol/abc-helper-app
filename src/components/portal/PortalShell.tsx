'use client';

import { ToastProvider } from '@/components/ui';
import { createBrowserSupabase } from '@/db/clients/browser';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useState } from 'react';

interface Props {
  workerName: string;
  onboarded: boolean;
  children: ReactNode;
}

const NAV_ITEMS = [
  { href: '/portal', label: 'Dashboard', icon: '🏠', exact: true },
  { href: '/portal/statements', label: 'Pay Statements', icon: '💰' },
  { href: '/portal/profile', label: 'Profile', icon: '👤' },
  { href: '/portal/onboarding', label: 'Onboarding', icon: '🧭' },
];

export const PortalShell = ({ workerName, onboarded, children }: Props) => {
  const pathname = usePathname();
  const [signingOut, setSigningOut] = useState(false);

  const isActive = (item: (typeof NAV_ITEMS)[number]) =>
    item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await createBrowserSupabase().auth.signOut();
    } finally {
      window.location.href = '/portal/login';
    }
  };

  return (
    <ToastProvider>
      <div className="portal">
        <header className="topbar">
          <h1 className="brand">
            Contractor Portal
            <small>ABC Kids NY</small>
          </h1>
          <div className="topbar-actions">
            <span className="sub" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {workerName}
            </span>
            <button type="button" className="btn ghost sm" onClick={signOut} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </header>

        <div className="shell">
          <nav className="sidebar no-print" aria-label="Portal sections">
            {NAV_ITEMS.map((item) => {
              // Hide non-onboarding items until onboarded (except dashboard)
              const hidden =
                !onboarded && item.href !== '/portal' && item.href !== '/portal/onboarding';
              if (hidden) return null;
              const active = isActive(item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={active ? 'side-item active' : 'side-item'}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="side-ico" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="side-label">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <main className="wrap" id="main">
            {children}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
};
