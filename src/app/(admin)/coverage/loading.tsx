/**
 * Coverage route skeleton — header card plus a few roster-row placeholders using
 * the shared `.skel` shimmer. Paints instantly while fetchCoverageRoster (a
 * multi-query per-worker aggregation) resolves, instead of freezing the prior page.
 */
export default function CoverageLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading coverage">
      <div className="card">
        <div className="skel" aria-hidden="true">
          <div className="skel-bar" style={{ width: '28%' }} />
          <div className="skel-bar" style={{ width: '52%' }} />
        </div>
      </div>
      <div className="card">
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list.
          <div key={i} className="skel" aria-hidden="true" style={{ padding: '8px 0' }}>
            <div className="skel-bar" style={{ width: '90%' }} />
          </div>
        ))}
      </div>
    </div>
  );
}
