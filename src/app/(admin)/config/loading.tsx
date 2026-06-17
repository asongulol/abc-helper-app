/**
 * Config page skeleton — header card + two card placeholders (admins + holidays).
 */
export default function ConfigLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading configuration">
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="skel">
          <div className="skel-bar" style={{ width: '30%' }} />
          <div className="skel-bar" style={{ width: '50%' }} />
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="skel">
          <div className="skel-bar" style={{ width: '40%' }} />
          {Array.from({ length: 4 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
            <div key={i} className="skel-bar" style={{ width: `${50 + (i % 4) * 10}%` }} />
          ))}
        </div>
      </div>
      <div className="card">
        <div className="skel">
          <div className="skel-bar" style={{ width: '38%' }} />
          {Array.from({ length: 6 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
            <div key={i} className="skel-bar" style={{ width: `${45 + (i % 5) * 9}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
