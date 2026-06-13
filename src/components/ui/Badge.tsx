import type { ReactNode } from 'react';

export type BadgeTone = 'good' | 'warn' | 'bad' | 'neutral';

/**
 * Status pill (legacy `.pill` with soft background tones). Tone maps to the
 * legacy palette: good = green, warn = amber, bad = red, neutral = grey.
 */
export const Badge = ({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) => <span className={`pill ${tone}`}>{children}</span>;
