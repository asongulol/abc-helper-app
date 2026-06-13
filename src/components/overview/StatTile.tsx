import type { ReactNode } from 'react';

type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

interface StatTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  icon?: string;
  /** If given, the tile is a button that calls this on click. */
  onClick?: () => void;
}

/**
 * Overview stat tile — port of the legacy `.ov-tile` pattern.
 * Renders as a button when onClick is provided, otherwise a static div.
 */
export const StatTile = ({ label, value, sub, tone = 'neutral', icon, onClick }: StatTileProps) => {
  const toneClass = tone !== 'neutral' ? ` t-${tone}` : '';
  const inner = (
    <>
      <div className="ov-tile-label">
        {icon != null && <span aria-hidden="true">{icon}</span>}
        {label}
      </div>
      <div className="ov-tile-num">{value}</div>
      {sub != null && <div className="ov-tile-sub">{sub}</div>}
    </>
  );

  if (onClick != null) {
    return (
      <button type="button" className={`ov-tile${toneClass}`} onClick={onClick}>
        {inner}
      </button>
    );
  }

  return (
    <div className={`ov-tile${toneClass}`} style={{ cursor: 'default' }}>
      {inner}
    </div>
  );
};
