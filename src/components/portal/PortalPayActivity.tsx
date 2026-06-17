'use client';

import { useEffect, useRef } from 'react';
import { peso } from '@/lib/format';

export interface HomePay {
  period: { start: string; end: string; pay: string };
  nextPay: { net: number; pay: string | null } | null;
  lastPaid: { net: number; pay: string | null } | null;
  elapsedDays: number;
  totalDays: number;
  pct: number;
}

interface Props {
  pay: HomePay;
  /** Per-worked-day activity %, oldest-first. */
  activity: { date: string; activity: number }[];
}

const fmtMD = (iso: string): string => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${iso}T00:00:00Z`));
  } catch {
    return iso;
  }
};
const fmtMDshort = (iso: string): string => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'numeric',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${iso}T00:00:00Z`));
  } catch {
    return iso.slice(5);
  }
};

/**
 * "Your pay" card + "Activity" chart — faithful port of the legacy portal pay
 * card and ActivityChart: Next-pay (pending) headline, the day-of-period
 * progress bar with the climbing sun, last-paid line, and a scrollable
 * activity-% bar chart with a 3-day centered-moving-average trend line.
 */
export const PortalPayActivity = ({ pay, activity }: Props) => {
  const scRef = useRef<HTMLDivElement>(null);
  // Start the activity scroll at the most recent day (right edge).
  useEffect(() => {
    if (scRef.current) scRef.current.scrollLeft = scRef.current.scrollWidth;
  }, []);

  const { period, nextPay, lastPaid, elapsedDays, totalDays, pct } = pay;

  // ── Activity chart geometry (matches legacy) ──
  const present = activity.filter((d) => d.activity != null);
  const avg = present.length
    ? Math.round(present.reduce((a, d) => a + d.activity, 0) / present.length)
    : null;
  const dayW = 36;
  const H = 104;
  const padTop = 16;
  const padBottom = 22;
  const W = Math.max(1, activity.length) * dayW;
  const svgH = H + padTop + padBottom;
  const yOf = (v: number) => padTop + H - (Math.max(0, Math.min(100, v)) / 100) * H;
  const cx = (i: number) => i * dayW + dayW / 2;
  const barW = dayW * 0.56;
  const col = (v: number) =>
    v >= 60 ? 'var(--good,#16a34a)' : v >= 35 ? 'var(--accent,#1F3A68)' : 'var(--warn,#d97706)';
  const nn = activity.map((d, i) => ({ i, v: d.activity })).filter((p) => p.v != null);
  const trend = nn
    .map((p, k) => {
      const lo = Math.max(0, k - 1);
      const hi = Math.min(nn.length - 1, k + 1);
      let s = 0;
      for (let j = lo; j <= hi; j++) s += nn[j]?.v ?? 0;
      return `${cx(p.i)},${yOf(s / (hi - lo + 1)).toFixed(1)}`;
    })
    .join(' ');

  return (
    <>
      <div className="dash-cell dash-pay">
        <div className="stickwrap">
          <span className="sticker">📮 Your pay</span>
        </div>
        <div className="paycard">
          <div className="row" style={{ alignItems: 'flex-end', padding: 0 }}>
            <div>
              <div className="sub" style={{ margin: 0 }}>
                Next pay
              </div>
              <div className="bigpay">{nextPay ? peso(nextPay.net) : peso(null)}</div>
              <div className="sub" style={{ margin: '2px 0 0' }}>
                {nextPay
                  ? `pays ${nextPay.pay || period.pay}`
                  : `being prepared · pays ${period.pay}`}
              </div>
            </div>
            <span className="pill pending">pending</span>
          </div>
          <div style={{ marginTop: 12 }}>
            <div className="sub" style={{ margin: 0 }}>
              Day {elapsedDays} of {totalDays} — sun's climbing toward payday
            </div>
            <div className="obar">
              <i style={{ width: `${pct}%` }} />
              <span className="paysun" style={{ left: `${pct}%` }}>
                ☀️
              </span>
            </div>
            <div
              className="sub"
              style={{
                margin: '2px 0 0',
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span>{fmtMD(period.start)}</span>
              <span>{fmtMD(period.end)}</span>
            </div>
          </div>
          <div className="hair" />
          <div className="row" style={{ padding: 0 }}>
            <span className="k">Last pay</span>
            <span>
              {lastPaid ? (
                <>
                  <b>{peso(lastPaid.net)}</b> · {lastPaid.pay || '—'}{' '}
                  <span className="pill paid">paid</span>
                </>
              ) : (
                '—'
              )}
            </span>
          </div>
        </div>
      </div>

      <div className="dash-cell dash-act">
        <div className="stickwrap">
          <span className="sticker">📊 Activity</span>
        </div>
        <div className="card">
          <div className="row" style={{ padding: 0, alignItems: 'baseline', gap: 8 }}>
            <p className="sub" style={{ marginTop: 0, marginBottom: 8, flex: 1 }}>
              Your activity % on each logged day (last {activity.length}) — scroll for more · line =
              3-day trend.
            </p>
            {avg != null && (
              <span
                style={{
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  color: 'var(--accent,#1F3A68)',
                }}
              >
                avg {avg}%
              </span>
            )}
          </div>
          {present.length === 0 ? (
            <div className="empty">No logged activity yet.</div>
          ) : (
            <div ref={scRef} style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <svg
                width={W}
                height={svgH}
                style={{ display: 'block' }}
                role="img"
                aria-label={`Daily activity, last ${activity.length} days`}
              >
                {[25, 50, 75].map((g) => (
                  <line
                    key={g}
                    x1="0"
                    x2={W}
                    y1={yOf(g)}
                    y2={yOf(g)}
                    stroke="var(--line,#eef2f7)"
                  />
                ))}
                {activity.map((d, i) => {
                  const v = d.activity;
                  const y = yOf(v);
                  return (
                    <g key={d.date}>
                      <rect
                        x={cx(i) - barW / 2}
                        y={y}
                        width={barW}
                        height={padTop + H - y}
                        fill={col(v)}
                        rx="3"
                        opacity="0.8"
                      >
                        <title>
                          {fmtMDshort(d.date)} · {v}%
                        </title>
                      </rect>
                      <text
                        x={cx(i)}
                        y={y - 4}
                        textAnchor="middle"
                        fontSize="9"
                        fill="var(--muted,#94a3b8)"
                      >
                        {v}
                      </text>
                    </g>
                  );
                })}
                {nn.length >= 2 && (
                  <polyline
                    points={trend}
                    fill="none"
                    stroke="var(--accent,#1F3A68)"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
                {activity.map((d, i) => (
                  <text
                    key={`d${d.date}`}
                    x={cx(i)}
                    y={svgH - 6}
                    textAnchor="middle"
                    fontSize="9"
                    fill="var(--muted,#94a3b8)"
                  >
                    {fmtMDshort(d.date)}
                  </text>
                ))}
              </svg>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
