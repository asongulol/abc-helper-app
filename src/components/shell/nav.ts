/**
 * Admin sidebar navigation model — extracted from AdminShell so the sidebar and
 * the command palette (⌘K) share one source of truth for sections, labels, and
 * icons. Grouped by workflow stage, mirroring the legacy sidebar groups
 * (legacy `tabGroups` / `NAV_ICON`).
 */

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

export interface NavGroup {
  label: string;
  items: ReadonlyArray<NavItem>;
  /**
   * Fully prefetch this group's routes (`<Link prefetch>`), so clicking between
   * them paints from the client cache instead of waiting on a round trip.
   *
   * Every admin route is dynamic, and Next's DEFAULT prefetch on a dynamic route
   * fetches only the `loading.tsx` boundary — which is exactly why these tabs
   * showed an instant spinner and then stalled. `prefetch` fetches the whole
   * route and parks it in the client cache's `static` bucket (5 min).
   *
   * Only on the tabs an admin cycles through mid-run. It is NOT free: each
   * prefetched route is a real server render, fired whenever the sidebar is on
   * screen. Three cheap pages is a fair trade; fifteen would not be.
   */
  prefetch?: true;
}

/**
 * Nav grouped by workflow stage, mirroring the legacy sidebar groups verbatim
 * (group label, item order, label, icon). Group labels render uppercase via the
 * `.side-group-label` CSS, so they stay title-case here.
 */
export const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  {
    label: 'Home',
    items: [{ href: '/overview', label: 'Overview', icon: '🏠' }],
  },
  {
    label: 'Manage Team',
    items: [
      { href: '/contractors', label: 'Contractors', icon: '👥' },
      { href: '/onboarding', label: 'Hiring & Onboarding', icon: '🧭' },
      { href: '/documents', label: 'Documents', icon: '📄' },
      { href: '/coverage', label: 'Coverage', icon: '📉' },
    ],
  },
  {
    label: 'Run payroll',
    prefetch: true,
    items: [
      { href: '/time', label: 'Time & Approval', icon: '⏱' },
      { href: '/payroll', label: 'Calculate', icon: '🧮' },
      { href: '/process', label: 'Process and Pay', icon: '💸' },
    ],
  },
  {
    label: 'Review',
    items: [
      { href: '/batches', label: 'Review & Recon Batches', icon: '📦' },
      { href: '/reports', label: 'Reports', icon: '📊' },
      { href: '/sessions', label: 'Sessions', icon: '🗓' },
      { href: '/invoicing', label: 'Invoicing', icon: '🧾' },
      { href: '/imports', label: 'Delete Imports', icon: '🗂' },
      { href: '/audit', label: 'Audit Log', icon: '📝' },
    ],
  },
  {
    label: 'Configuration',
    items: [{ href: '/config', label: 'Configuration', icon: '⚙' }],
  },
];
