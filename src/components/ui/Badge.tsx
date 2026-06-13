import type { CSSProperties, ReactNode } from 'react';

export type BadgeTone = 'good' | 'warn' | 'bad' | 'neutral';

/**
 * Status pill (legacy `.pill` with soft background tones). Tone maps to the
 * legacy palette: good = green, warn = amber, bad = red, neutral = grey.
 * `title` (hover tooltip) and `style` (inline spacing) are optional
 * passthroughs used by the payroll/process/onboarding status cells.
 */
export const Badge = ({
  tone = 'neutral',
  children,
  title,
  style,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  title?: string;
  style?: CSSProperties;
}) => (
  <span
    className={`pill ${tone}`}
    {...(title !== undefined ? { title } : {})}
    {...(style ? { style } : {})}
  >
    {children}
  </span>
);
