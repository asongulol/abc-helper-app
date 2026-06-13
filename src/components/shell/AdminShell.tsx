'use client';

import { ToastProvider } from '@/components/ui';
import { createBrowserSupabase } from '@/db/clients/browser';
import { selectCompany } from '@/server/actions/company';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState, useTransition } from 'react';

export interface ShellAdmin {
  email: string;
  name: string | null;
  isOwner: boolean;
}

export interface ShellCompany {
  id: string;
  name: string;
}

interface AdminShellProps {
  admin: ShellAdmin;
  companies: ShellCompany[];
  selectedCompanyId: string | null;
  children: ReactNode;
}

interface NavItem {
  href: string;
  label: string;
  icon: string;
}

/** Nav grouped by workflow stage, mirroring the legacy sidebar groups. */
const NAV_GROUPS: ReadonlyArray<{ label: string; items: ReadonlyArray<NavItem> }> = [
  { label: 'Home', items: [{ href: '/overview', label: 'Overview', icon: '🏠' }] },
  {
    label: 'Manage team',
    items: [
      { href: '/contractors', label: 'Contractors', icon: '👥' },
      { href: '/onboarding', label: 'Onboarding', icon: '🧭' },
      { href: '/documents', label: 'Documents', icon: '📄' },
    ],
  },
  {
    label: 'Run payroll',
    items: [
      { href: '/time', label: 'Time Import', icon: '⏱' },
      { href: '/payroll', label: 'Payroll', icon: '🧮' },
      { href: '/process', label: 'Process & Pay', icon: '💸' },
    ],
  },
  {
    label: 'Review',
    items: [
      { href: '/reports', label: 'Reports', icon: '📊' },
      { href: '/audit', label: 'Audit Log', icon: '📝' },
      { href: '/imports', label: 'Delete Imports', icon: '🗂' },
    ],
  },
  {
    label: 'Configuration',
    items: [{ href: '/config', label: 'Configuration', icon: '⚙' }],
  },
];

const COLLAPSE_KEY = 'abc_sidebar_collapsed';

/**
 * Admin app shell — faithful port of the legacy topbar (navy bar, gold top
 * border, brand + company switcher + user menu) and the collapsible left
 * sidebar (212px expanded / 60px collapsed, persisted in localStorage).
 */
export const AdminShell = ({ admin, companies, selectedCompanyId, children }: AdminShellProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [switching, startSwitch] = useTransition();
  const [signingOut, setSigningOut] = useState(false);

  // Restore the persisted collapse state after mount (SSR renders expanded).
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* storage unavailable */
    }
  }, []);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };

  const onCompanyChange = (companyId: string) => {
    if (!companyId || companyId === selectedCompanyId) return;
    startSwitch(async () => {
      await selectCompany(companyId);
      router.refresh();
    });
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await createBrowserSupabase().auth.signOut();
    } finally {
      window.location.href = '/login';
    }
  };

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <ToastProvider>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <h1 className="brand">
          ABC Kids — HR &amp; Payroll
          <small>PH independent contractors</small>
        </h1>
        <div className="topbar-actions">
          <div className="company-switcher">
            <select
              aria-label="Company"
              value={selectedCompanyId ?? ''}
              onChange={(e) => onCompanyChange(e.target.value)}
              disabled={switching || companies.length === 0}
              style={{ marginLeft: 'auto' }}
            >
              {companies.length === 0 && <option value="">No companies</option>}
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <span
            className="sub"
            style={{ fontSize: 12, whiteSpace: 'nowrap', margin: 0 }}
            title="Signed in"
          >
            {admin.email}
          </span>
          <button type="button" className="btn ghost sm" onClick={signOut} disabled={signingOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>
      <div className="shell">
        <nav
          className={collapsed ? 'sidebar collapsed no-print' : 'sidebar no-print'}
          aria-label="Sections"
        >
          {NAV_GROUPS.map((group) => (
            <div className="side-group" key={group.label}>
              <div className="side-group-label">{group.label}</div>
              {group.items.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={active ? 'side-item active' : 'side-item'}
                    aria-current={active ? 'page' : undefined}
                    title={collapsed ? item.label : undefined}
                  >
                    <span className="side-ico" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className="side-label">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
          <button
            type="button"
            className="side-collapse"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            <span className="side-ico" aria-hidden="true">
              {collapsed ? '»' : '«'}
            </span>
            <span className="side-label">Collapse</span>
          </button>
        </nav>
        <main className="wrap" id="main">
          {children}
        </main>
      </div>
    </ToastProvider>
  );
};
