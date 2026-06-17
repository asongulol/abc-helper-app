/**
 * /time route skeleton — shown during Server Component data fetch.
 */
export default function TimeLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading time import">
      <div className="card">
        <div className="skel" aria-hidden="true">
          <div className="skel-bar" style={{ width: '38%' }} />
          <div className="skel-bar" style={{ width: '60%' }} />
        </div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="skel" aria-hidden="true">
          <div className="skel-bar" style={{ width: '55%' }} />
          <div className="skel-bar" style={{ width: '80%' }} />
          <div className="skel-bar" style={{ width: '45%' }} />
        </div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="skel" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list.
            <div key={i} className="skel-bar" style={{ width: `${65 + i * 5}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
