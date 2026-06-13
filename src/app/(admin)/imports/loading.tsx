/**
 * /imports route skeleton — shown during Server Component data fetch.
 */
export default function ImportsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading import batches">
      <div className="card">
        <div className="skel" aria-hidden="true">
          <div className="skel-bar" style={{ width: '34%' }} />
          <div className="skel-bar" style={{ width: '56%' }} />
        </div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="skel" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list.
            <div key={i} className="skel-bar" style={{ width: `${60 + i * 6}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
