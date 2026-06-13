import type { ReactNode } from 'react';

/**
 * Helpful empty state (legacy `.empty`): explains what goes here and offers
 * the first action (per docs/ux-ui-guidelines.md "Error Prevention & Recovery").
 */
export const EmptyState = ({
  icon,
  message,
  children,
  action,
}: {
  icon?: ReactNode;
  /** Primary content. `children` is accepted as an alias for ergonomic JSX. */
  message?: ReactNode;
  children?: ReactNode;
  /** Optional call-to-action slot (e.g. a primary button). */
  action?: ReactNode;
}) => (
  <div className="empty">
    {icon != null && (
      <div style={{ fontSize: 28, marginBottom: 8 }} aria-hidden="true">
        {icon}
      </div>
    )}
    <div>{message ?? children}</div>
    {action != null && <div style={{ marginTop: 12 }}>{action}</div>}
  </div>
);
