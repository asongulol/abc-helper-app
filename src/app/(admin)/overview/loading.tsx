/**
 * Overview route skeleton — mirrors the legacy cold-load state: a header card
 * plus six tile placeholders, all using the shared `.skel` shimmer styles.
 */
export default function OverviewLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading overview">
      <div className="card">
        <div className="skel" aria-hidden="true">
          <div className="skel-bar" style={{ width: '32%' }} />
          <div className="skel-bar" style={{ width: '58%' }} />
        </div>
      </div>
      <div className="ov-grid">
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list.
          <div key={i} className="ov-tile" aria-hidden="true" style={{ cursor: 'default' }}>
            <div className="skel">
              <div className="skel-bar" style={{ width: '68%' }} />
              <div className="skel-bar" style={{ width: '40%' }} />
              <div className="skel-bar" style={{ width: '82%' }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
