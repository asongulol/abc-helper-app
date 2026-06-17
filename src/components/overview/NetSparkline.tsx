import type { RecentPeriodNet } from '@/db/queries/overview';
import { centavosToPhp, fmtDate, money } from '@/lib/format';
import { toPixelPoints, toPolylinePoints, toSparkPoints } from '@/lib/overview/spark';

interface NetSparklineProps {
  periods: RecentPeriodNet[];
  /**
   * Percent change of the latest period vs the prior one, computed by the page
   * from this same series. `null` when there is no prior period to compare.
   */
  deltaPct?: number | null;
}

const W = 220;
const H = 52;
const PAD = 6;

/**
 * Recent-periods net-pay sparkline — pure SVG, no chart library.
 * Renders inline in a Server Component (CSP-safe, zero JS).
 */
export const NetSparkline = ({ periods, deltaPct = null }: NetSparklineProps) => {
  if (periods.length === 0) {
    return (
      <div className="ov-spark-wrap">
        <span className="muted" style={{ fontSize: 12 }}>
          No completed periods yet.
        </span>
      </div>
    );
  }

  const sparkPeriods = periods.map((p) => ({
    label: `${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}`,
    totalNetPhp: p.totalNetPhp,
  }));

  const points = toSparkPoints(sparkPeriods);
  const pixels = toPixelPoints(points, W, H, PAD);
  const polyline = toPolylinePoints(pixels);

  const lastPeriod = periods[periods.length - 1];
  const lastNet = lastPeriod?.totalNetPhp ?? 0;
  // integer centavos for display
  const lastNetDisplay = money(centavosToPhp(Math.round(lastNet * 100)));

  // Delta arrow + tone — mirrors the legacy ▲/▼/▬ thresholds (±0.5%).
  const deltaTone =
    deltaPct == null ? 'flat' : deltaPct > 0.5 ? 'up' : deltaPct < -0.5 ? 'down' : 'flat';
  const deltaArrow = deltaPct == null ? '—' : deltaPct > 0.5 ? '▲' : deltaPct < -0.5 ? '▼' : '▬';

  return (
    <div className="ov-spark-wrap">
      <div className="ov-spark-meta">
        <div className="ov-tile-label">
          <span aria-hidden="true">📈</span>NET PAY · last {periods.length} periods
        </div>
        <div className="ov-tile-num" style={{ fontSize: 22, margin: '2px 0' }}>
          {lastNetDisplay}
        </div>
        <span className={`ov-delta ${deltaTone}`}>
          {deltaPct == null
            ? '— vs prior period'
            : `${deltaArrow} ${Math.abs(deltaPct).toFixed(1)}% vs prior period`}
        </span>
      </div>
      <svg
        className="ov-spark"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        aria-label="Net pay sparkline"
        role="img"
        style={{ display: 'block', flexShrink: 0 }}
      >
        {pixels.length > 1 && (
          <>
            {/* Area fill */}
            <polyline
              points={`${pixels[0]?.x ?? PAD},${H} ${polyline} ${pixels[pixels.length - 1]?.x ?? W - PAD},${H}`}
              fill="rgba(31,58,104,0.08)"
              stroke="none"
            />
            {/* Line */}
            <polyline
              points={polyline}
              fill="none"
              stroke="var(--navy)"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {/* Last point dot */}
            {pixels[pixels.length - 1] != null && (
              <circle
                cx={pixels[pixels.length - 1]?.x}
                cy={pixels[pixels.length - 1]?.y}
                r="4"
                fill="var(--navy)"
              />
            )}
          </>
        )}
        {/* Single point: just a dot */}
        {pixels.length === 1 && pixels[0] != null && (
          <circle cx={pixels[0].x} cy={pixels[0].y} r="5" fill="var(--navy)" />
        )}
      </svg>
    </div>
  );
};
