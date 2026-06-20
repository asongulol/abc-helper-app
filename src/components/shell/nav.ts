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
    ],
  },
  {
    label: 'Run payroll',
    items: [
      { href: '/time', label: 'Time & Approval', icon: '⏱' },
      { href: '/calculate', label: 'Calculate', icon: '🧮' },
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
      { href: '/imports', label: 'Imports', icon: '🗂' },
      { href: '/audit', label: 'Audit Log', icon: '📝' },
    ],
  },
  {
    label: 'Configuration',
    items: [{ href: '/config', label: 'Configuration', icon: '⚙' }],
  },
];
