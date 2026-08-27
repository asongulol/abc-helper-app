import Link from 'next/link';
import type { ReactNode } from 'react';

type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

interface StatTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  icon?: string;
  /** Legacy error state — renders "Couldn't load — press Refresh" and a bad tone. */
  error?: boolean;
  /** If given, the tile is a link to this route (preferred: real href, middle-clickable). */
  href?: string;
  /** If given, the tile is a button that calls this on click. */
  onClick?: () => void;
}

/**
 * Overview stat tile — port of the legacy `.ov-tile` pattern.
 *
 * A tile that states a problem must also be the way to it: pass `href` and the
 * tile renders as a `<Link>` (discernible name for AT, middle-click, focus
 * ring). `onClick` is kept for the in-page filter tiles; with neither, it is a
 * static figure and is styled as one rather than faking affordance.
 */
export const StatTile = ({
  label,
  value,
  sub,
  tone = 'neutral',
  icon,
  error = false,
  href,
  onClick,
}: StatTileProps) => {
  const effectiveTone: Tone = error ? 'bad' : tone;
  const toneClass = effectiveTone !== 'neutral' ? ` t-${effectiveTone}` : '';
  const inner = (
    <>
      <div className="ov-tile-label">
        {icon != null && <span aria-hidden="true">{icon}</span>}
        {label}
      </div>
      <div
        className="ov-tile-num"
        style={error ? { fontSize: 15, color: 'var(--bad)' } : undefined}
      >
        {error ? '—' : value}
      </div>
      <div className="ov-tile-sub">
        {error ? (
          <span style={{ color: 'var(--bad)' }}>Couldn&apos;t load — press Refresh</span>
        ) : (
          sub
        )}
      </div>
    </>
  );

  if (href != null) {
    return (
      <Link href={href} className={`ov-tile is-link${toneClass}`}>
        {inner}
        <span className="ov-tile-go" aria-hidden="true">
          →
        </span>
      </Link>
    );
  }

  if (onClick != null) {
    return (
      <button type="button" className={`ov-tile is-link${toneClass}`} onClick={onClick}>
        {inner}
      </button>
    );
  }

  return <div className={`ov-tile${toneClass}`}>{inner}</div>;
};
