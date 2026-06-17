/**
 * Audit log skeleton — mirrors the page structure: a header card and a table
 * placeholder with several row shimmer bars.
 */
export default function AuditLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading audit log">
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="skel">
          <div className="skel-bar" style={{ width: '28%' }} />
          <div className="skel-bar" style={{ width: '55%' }} />
        </div>
      </div>
      <div className="card">
        <div className="skel">
          {Array.from({ length: 8 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
            <div key={i} className="skel-bar" style={{ width: `${60 + (i % 5) * 8}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
