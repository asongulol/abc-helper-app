'use client';

export interface HireDraftBannerProps {
  /** Saved draft summary line, e.g. "John Doe · 123 BabyTalks". */
  summary: string;
  onResume: () => void;
  onDiscard: () => void;
}

/**
 * Amber "unfinished hire draft" resume banner shown on the Contractors screen
 * when a `eis_hire_draft_<companyId>` exists. Resume reopens the wizard at the
 * saved step; Discard clears the draft. Faithful port of the legacy resume nudge.
 */
export const HireDraftBanner = ({ summary, onResume, onDiscard }: HireDraftBannerProps) => (
  <div
    className="banner"
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      marginBottom: 12,
      borderColor: 'var(--warn)',
      background: 'var(--warn-soft)',
      color: 'var(--warn)',
    }}
  >
    <span>↩ Unfinished hire draft{summary ? ` — ${summary}` : ''}.</span>
    <span style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
      <button type="button" className="btn sm" onClick={onResume}>
        Resume
      </button>
      <button type="button" className="btn ghost sm" onClick={onDiscard}>
        Discard
      </button>
    </span>
  </div>
);
