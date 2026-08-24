'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState, useTransition } from 'react';
import { Mark } from '@/components/brand/Mark';
import { ToastProvider } from '@/components/ui';
import { BackToTop } from '@/components/ui/BackToTop';
import { Modal } from '@/components/ui/Modal';
import { createBrowserSupabase } from '@/db/clients/browser';
import type { AdminRow } from '@/db/queries/admins';
import { selectClients } from '@/server/actions/company';
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
  /** CLIENT companies for the header filter (billing tags, not tenants). */
  clients: ShellCompany[];
  /** Client ids currently filtered to; empty = all. */
  selectedClientIds: string[];
  contractors: ReadonlyArray<{ id: string; name: string }>;
  periods: ReadonlyArray<{ id: string; label: string; start: string }>;
  /** Admin roster for the owner-only Admins modal (empty for non-owners). */
  admins: ReadonlyArray<AdminRow>;
  children: ReactNode;
}

const COLLAPSE_KEY = 'abc_sidebar_collapsed';

/** The four primary destinations pinned to the mobile bottom-nav; everything
 *  else is reachable via the "More" sheet. */
const PRIMARY_NAV: ReadonlyArray<{ href: string; label: string; icon: string }> = [
  { href: '/overview', label: 'Overview', icon: '🏠' },
  { href: '/contractors', label: 'Team', icon: '👥' },
  { href: '/time', label: 'Time', icon: '⏱' },
  { href: '/payroll', label: 'Calculate', icon: '🧮' },
];

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
  clients,
  selectedClientIds,
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
  const [moreOpen, setMoreOpen] = useState(false);
  const sections = NAV_GROUPS.flatMap((g) => g.items);

  // Close the mobile "More" sheet whenever the route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not a read dep.
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  // Escape closes the "More" sheet.
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen]);

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

  // Close the Client dropdown on outside click (<details> has no light-dismiss).
  const clientMenuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const d = clientMenuRef.current;
      if (d?.open && e.target instanceof Node && !d.contains(e.target)) d.removeAttribute('open');
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  const toggleClient = (clientId: string) => {
    const next = selectedClientIds.includes(clientId)
      ? selectedClientIds.filter((id) => id !== clientId)
      : [...selectedClientIds, clientId];
    startSwitch(async () => {
      await selectClients(next);
      router.refresh();
    });
  };

  const clientSummary =
    selectedClientIds.length === 0
      ? 'All clients'
      : selectedClientIds.length === 1
        ? (clients.find((c) => c.id === selectedClientIds[0])?.name ?? '1 client')
        : `${selectedClientIds.length} clients`;

  const signOut = async () => {
    setSigningOut(true);
    try {
      // Local scope: sign out this device only, not every session open elsewhere. (#031)
      await createBrowserSupabase().auth.signOut({ scope: 'local' });
    } finally {
      window.location.href = '/login';
    }
  };

  // Back after sign-out can repaint this admin view from the browser's cache —
  // a live-looking payroll page with a dead session (bfcache, or an HTTP-cached
  // document on a back/forward nav). Either way the proxy never re-checked auth,
  // so force a real load, which redirects a signed-out user to /login. Fires only
  // on cache-served full-document loads (persisted, or navigation type
  // back_forward), never on a fresh navigate/reload, so there's no loop and
  // in-app client-side Back is unaffected. (#023)
  useEffect(() => {
    // A fresh cache-served back/forward document fires `pageshow` before this
    // effect attaches, so catch that case by inspecting the navigation type on
    // mount; `pageshow`/persisted covers a true bfcache restore (listener already
    // attached from before). Reload re-requests through the proxy, which sends a
    // signed-out user to /login. navType is 'reload' after reload → no loop.
    const navType = (
      performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    )?.type;
    if (navType === 'back_forward') {
      window.location.reload();
      return;
    }
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

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
                Client
              </span>
              <details ref={clientMenuRef} style={{ position: 'relative' }}>
                <summary
                  className="btn ghost sm"
                  style={{ listStyle: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}
                  title="Filter contractors by client assignment"
                >
                  {clientSummary} ▾
                </summary>
                <div
                  className="card"
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 'calc(100% + 6px)',
                    zIndex: 50,
                    minWidth: 240,
                    padding: 10,
                    display: 'grid',
                    gap: 6,
                  }}
                >
                  {clients.map((c) => (
                    <label
                      key={c.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedClientIds.includes(c.id)}
                        disabled={switching}
                        onChange={() => toggleClient(c.id)}
                      />
                      {c.name}
                    </label>
                  ))}
                  {clients.length === 0 && <span className="sub">No client companies.</span>}
                  {selectedClientIds.length > 0 && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={switching}
                      onClick={() => {
                        startSwitch(async () => {
                          await selectClients([]);
                          router.refresh();
                        });
                      }}
                    >
                      Clear — show all
                    </button>
                  )}
                </div>
              </details>
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
                    prefetch={group.prefetch ?? 'auto'}
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

      {/* Mobile bottom tab bar + "More" sheet (shown <=768px via CSS; the sidebar
          is hidden there). Bottom-bar styling lives in globals.css (.bottom-nav);
          the "More" sheet renders through the shared <Modal>. */}
      <nav className="bottom-nav no-print" aria-label="Primary">
        {PRIMARY_NAV.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={active ? 'bnav active' : 'bnav'}
              aria-current={active ? 'page' : undefined}
            >
              <span className="bnav-ico" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </Link>
          );
        })}
        <button
          type="button"
          className="bnav"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          <span className="bnav-ico" aria-hidden="true">
            ⋯
          </span>
          More
        </button>
      </nav>

      {moreOpen && (
        <Modal title="All sections" onClose={() => setMoreOpen(false)}>
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
                    onClick={() => setMoreOpen(false)}
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
        </Modal>
      )}

      <BackToTop />
    </ToastProvider>
  );
};
