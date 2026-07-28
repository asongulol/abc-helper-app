'use client';

/**
 * Shared body for the route-level `error.tsx` boundaries (RP-48).
 *
 * Without a boundary, an unhandled render/data error takes the whole segment
 * down to Next.js's bare error screen — no nav, no way back, and in production
 * no indication of what failed. Recovery here is `reset()`, which re-renders
 * the segment without a full page reload, so unsaved state elsewhere survives.
 *
 * `error.message` is deliberately shown: these screens are staff-only, and the
 * actions already route their messages through humanizeError. `digest` is the
 * server-side correlation id Next.js substitutes for the message in production.
 */
export const RouteError = ({
  error,
  reset,
  scope,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** What broke, in the user's words — "This page", "Your portal". */
  scope: string;
}) => (
  <div className="card" style={{ maxWidth: 560, margin: '48px auto' }}>
    <h2 style={{ margin: '0 0 8px' }}>{scope} didn&apos;t load</h2>
    <p className="sub" style={{ marginTop: 0 }}>
      Nothing was saved or changed by this error. Try again — if it keeps happening, send whoever
      supports this app the details below.
    </p>
    <pre
      style={{
        background: 'var(--bad-soft)',
        padding: '8px 10px',
        borderRadius: 6,
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        overflowX: 'auto',
        margin: '12px 0',
      }}
    >
      {error.message || 'Unknown error'}
      {error.digest ? `\nReference: ${error.digest}` : ''}
    </pre>
    <button type="button" className="btn primary" onClick={reset}>
      Try again
    </button>
  </div>
);
