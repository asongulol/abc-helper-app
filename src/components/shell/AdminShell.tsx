'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState, useTransition } from 'react';
import { Mark } from '@/components/brand/Mark';
import { ToastProvider } from '@/components/ui';
import { createBrowserSupabase } from '@/db/clients/browser';
import type { AdminRow } from '@/db/queries/admins';
import { selectCompany } from '@/server/actions/company';
import { AdminsModal } from './AdminsModal';
import { CommandPalette } from './CommandPalette';
import { NAV_GROUPS } from './nav';

export interface ShellAdmin {
  /** Auth user id — marks "(you)" in the Admins modal. */
  userId: string;
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
  contractors: ReadonlyArray<{ id: string; name: string }>;
  periods: ReadonlyArray<{ id: string; label: string; start: string }>;
  /** Admin roster for the owner-only Admins modal (empty for non-owners). */
  admins: ReadonlyArray<AdminRow>;
  children: ReactNode;
}

const COLLAPSE_KEY = 'abc_sidebar_collapsed';

/** Centered footer build stamp. NEXT_PUBLIC_BUILD is set in next.config.ts from
 * VERCEL_GIT_COMMIT_SHA at build time, so this fallback only shows if that ever
 * fails to resolve. */
const BUILD = process.env.NEXT_PUBLIC_BUILD ?? 'local · unstamped';

/**
 * Admin app shell — faithful port of the legacy topbar (navy bar, gold top
 * border, brand + company switcher + user menu) and the collapsible left
 * sidebar (212px expanded / 60px collapsed, persisted in localStorage).
 */
export const AdminShell = ({
  admin,
  companies,
  selectedCompanyId,
  contractors,
  periods,
  admins,
  children,
}: AdminShellProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [switching, startSwitch] = useTransition();
  const [signingOut, setSigningOut] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showAdmins, setShowAdmins] = useState(false);
  const sections = NAV_GROUPS.flatMap((g) => g.items);

  // ⌘K / Ctrl-K toggles the quick-find palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
      {paletteOpen && (
        <CommandPalette
          sections={sections}
          contractors={contractors}
          periods={periods}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {admin.isOwner && showAdmins && (
        <AdminsModal
          admins={admins}
          companyOptions={companies}
          meId={admin.userId}
          onClose={() => setShowAdmins(false)}
        />
      )}
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <h1 className="brand">
          <span
            style={{
              marginRight: 12,
              verticalAlign: 'middle',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <Mark height={38} priority />
          </span>
          HR &amp; Payroll<small>PH independent contractors</small>
        </h1>
        <div className="topbar-actions">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setPaletteOpen(true)}
            title="Quick find (⌘K / Ctrl-K)"
            aria-label="Quick find"
          >
            🔎 Find
          </button>
          <div className="company-switcher">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginLeft: 'auto',
              }}
            >
              <span className="muted" style={{ fontSize: 12 }}>
                Employer
              </span>
              <select
                aria-label="Company"
                value={selectedCompanyId ?? ''}
                onChange={(e) => onCompanyChange(e.target.value)}
                disabled={switching || companies.length <= 1}
                title={
                  companies.length <= 1
                    ? 'The payroll home for every contractor'
                    : 'Switch employer (tenant)'
                }
              >
                {companies.length === 0 && <option value="">No companies</option>}
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <span
            className="sub"
            style={{ fontSize: 12, whiteSpace: 'nowrap', margin: 0 }}
            title="Signed in"
          >
            {admin.email}
          </span>
          {admin.isOwner && (
            <button type="button" className="btn ghost sm" onClick={() => setShowAdmins(true)}>
              Admins
            </button>
          )}
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
          <div
            className="no-print"
            style={{
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 11,
              padding: '18px 0 32px',
              letterSpacing: '.02em',
            }}
          >
            Build {BUILD}
          </div>
        </main>
      </div>
    </ToastProvider>
  );
};
