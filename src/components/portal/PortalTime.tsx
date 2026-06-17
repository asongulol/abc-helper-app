'use client';

import { useState } from 'react';
import type { PortalTimeEntryRow } from '@/db/queries/portal';

interface DayRow {
  date: string;
  tracked: number;
  pto: number;
}

interface Period {
  key: string;
  tracked: number;
  pto: number;
  byDay: Map<string, DayRow>;
  daysList: DayRow[];
  days: number;
}

/** Legacy hrs(): seconds → hours (number). portal/index.html:526 */
const hrs = (seconds: number): number => seconds / 3600;

// Fixed en-US locale (legacy used the browser locale) so server-rendered HTML
// always matches client hydration. Mirrors legacy fmtDay → "Mon, Jun 12".
const DAY_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const fmtDay = (d: string): string => {
  const date = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return d;
  return DAY_FMT.format(date);
};

export const PortalTime = ({ entries }: { entries: PortalTimeEntryRow[] }) => {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (!entries.length) {
    return <div className="empty">No time recorded yet.</div>;
  }

  // group by semi-monthly period, keeping a per-day breakdown for the drill-down
  const byPeriod = new Map<string, Period>();
  for (const r of entries) {
    const d = r.workDate;
    const half = Number(d.slice(8, 10)) <= 15 ? '01–15' : '16–end';
    const key = `${d.slice(0, 7)} ${half}`;
    let g = byPeriod.get(key);
    if (!g) {
      g = { key, tracked: 0, pto: 0, byDay: new Map(), daysList: [], days: 0 };
      byPeriod.set(key, g);
    }
    g.tracked += r.trackedSeconds;
    g.pto += r.ptoSeconds;
    let day = g.byDay.get(d);
    if (!day) {
      day = { date: d, tracked: 0, pto: 0 };
      g.byDay.set(d, day);
    }
    day.tracked += r.trackedSeconds;
    day.pto += r.ptoSeconds;
  }

  const periods = [...byPeriod.values()].map((g) => {
    g.daysList = [...g.byDay.values()]
      .filter((x) => x.tracked > 0 || x.pto > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    g.days = g.daysList.length;
    return g;
  });

  // Entries arrive newest-first, so the first period is the current one.
  const latest = periods[0];

  return (
    <>
      <div className="pagehead">
        <span className="sticker">⏱ Your time</span>
      </div>
      {latest && (
        <div className="summary">
          <div className="scell">
            <div className="v">{(hrs(latest.tracked) + hrs(latest.pto)).toFixed(1)} h</div>
            <div className="l">{latest.key} total</div>
          </div>
          <div className="scell">
            <div className="v">{latest.days}</div>
            <div className="l">day{latest.days === 1 ? '' : 's'} worked</div>
          </div>
        </div>
      )}
      {periods.map((g) => {
        const isOpen = !!open[g.key];
        return (
          <div className="card" key={g.key}>
            {/* biome-ignore lint/a11y/useSemanticElements: container wraps block-level rows/headers that cannot be nested inside a native <button>; role=button + key handler give keyboard parity. */}
            <div
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpen((o) => ({ ...o, [g.key]: !o[g.key] }));
                }
              }}
              style={{ cursor: 'pointer' }}
            >
              <div
                style={{
                  fontWeight: 700,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>{g.key}</span>
                <span className="sub" style={{ fontWeight: 500 }}>
                  {g.days} day{g.days === 1 ? '' : 's'} {isOpen ? '▾' : '▸'}
                </span>
              </div>
              <div className="row">
                <span className="k">Worked</span>
                <span>{hrs(g.tracked).toFixed(2)} h</span>
              </div>
              {g.pto > 0 && (
                <div className="row">
                  <span className="k">PTO</span>
                  <span style={{ color: 'var(--gold)', fontWeight: 600 }}>
                    {hrs(g.pto).toFixed(2)} h
                  </span>
                </div>
              )}
              <div className="row" style={{ fontWeight: 700 }}>
                <span>Total</span>
                <span>{(hrs(g.tracked) + hrs(g.pto)).toFixed(2)} h</span>
              </div>
            </div>
            {isOpen && (
              <div
                style={{
                  marginTop: 8,
                  paddingTop: 8,
                  borderTop: '1px solid #e5e7eb',
                }}
              >
                {g.daysList.length === 0 ? (
                  <div className="sub">No daily entries.</div>
                ) : (
                  g.daysList.map((day) => (
                    <div className="row" key={day.date}>
                      <span className="k">{fmtDay(day.date)}</span>
                      <span>
                        {(hrs(day.tracked) + hrs(day.pto)).toFixed(2)} h
                        {day.pto > 0 ? ` · ${hrs(day.pto).toFixed(2)} PTO` : ''}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
};
