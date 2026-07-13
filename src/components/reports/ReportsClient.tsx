'use client';

/**
 * Reports admin screen — faithful single-scroll recreation of the legacy
 * `Reports()` view (app/index.html ~7484-8376). Five blocks, top to bottom:
 *   1. KPI stats strip
 *   2. Payout by pay period (Year/Month chip filters + per-contractor drilldown)
 *   3. Contractor Pay Summary (date range + contractor picker + CSV exports)
 *   4. Contractor pay & hours history (single-contractor picker + CSV)
 *   5. Avg. Weekly Activity (contractor picker)
 *
 * Admin money renders via money() ("PHP " prefix); USD reference via
 * money(x,'USD') ("$"). Data comes pre-computed from getReportsData; the
 * History and Activity blocks fetch lazily per pick.
 */

import { Fragment, useEffect, useState, useTransition } from 'react';
import { StatTile } from '@/components/overview/StatTile';
import { ContractorPicker } from '@/components/ui';
import { money } from '@/lib/format';
import { payoutMethodLabel } from '@/lib/payroll/status-pills';
import {
  getContractorHistory,
  getUtilization,
  type HistoryRow,
  type ReportsData,
  type UtilizationRow,
} from '@/server/actions/reports-detail';

interface Props {
  companyId: string;
  data: ReportsData;
}

const MONTHS: ReadonlyArray<[string, string]> = [
  ['01', 'Jan'],
  ['02', 'Feb'],
  ['03', 'Mar'],
  ['04', 'Apr'],
  ['05', 'May'],
  ['06', 'Jun'],
  ['07', 'Jul'],
  ['08', 'Aug'],
  ['09', 'Sep'],
  ['10', 'Oct'],
  ['11', 'Nov'],
  ['12', 'Dec'],
];

const PAID = (st: string | null): boolean => st === 'sent' || st === 'reconciled';

const num = (n: number): string => n.toFixed(2);

// --- CSV helpers (browser download; legacy downloadCSV) ---------------------
const csvEscape = (v: string | number | null | undefined): string => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const downloadCSV = (filename: string, rows: Array<Array<string | number | null | undefined>>) => {
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

const toggleSet = (set: Set<string>, setter: (n: Set<string>) => void, v: string) => {
  const n = new Set(set);
  if (n.has(v)) n.delete(v);
  else n.add(v);
  setter(n);
};

export const ReportsClient = ({ companyId, data }: Props) => {
  const { periods, grandNet, grandUsd, grandUnpaid } = data;

  // ---- Payout-by-period Year/Month filter (default = current month + year) --
  const now = new Date();
  const [fYears, setFYears] = useState<Set<string>>(() => new Set([String(now.getFullYear())]));
  const [fMonths, setFMonths] = useState<Set<string>>(
    () => new Set([String(now.getMonth() + 1).padStart(2, '0')]),
  );
  const [openKey, setOpenKey] = useState<string | null>(null);

  const yearsAvail = [...new Set(periods.map((p) => (p.start || '').slice(0, 4)).filter(Boolean))]
    .sort()
    .reverse();
  const shown = periods.filter((p) => {
    const y = (p.start || '').slice(0, 4);
    const m = (p.start || '').slice(5, 7);
    return (fYears.size === 0 || fYears.has(y)) && (fMonths.size === 0 || fMonths.has(m));
  });
  const fNet = shown.reduce((s, p) => s + p.net, 0);
  const fUsd = shown.reduce((s, p) => s + (p.usdRef || 0), 0);
  const filterActive = fYears.size > 0 || fMonths.size > 0;
  // #012: the ≈USD total only covers periods with a cached FX snapshot; the rest
  // render "—" and contribute $0. Disclose how many were left out so the total
  // doesn't read as complete.
  const grandNoFx = periods.filter((p) => !p.fx).length;
  const shownNoFx = shown.filter((p) => !p.fx).length;

  const nCols = 7; // ▸ | Period | Pay date | Contractors | Net | ≈USD | Unpaid

  return (
    <div>
      {/* ---- 1. KPI stats strip ---- */}
      <div className="card">
        <h2>Reports</h2>
        <p className="sub">
          Totals come from locked/saved pay statements. Showing the selected company. Click a period
          to see the per-contractor breakdown.
        </p>
        <div className="ov-grid">
          <StatTile label="Total net (all periods)" value={money(grandNet, 'PHP')} />
          <StatTile
            label="Total ≈ USD ref"
            value={money(grandUsd, 'USD')}
            sub={grandNoFx > 0 ? `FX-known periods only · ${grandNoFx} excluded` : undefined}
          />
          <StatTile
            label="Unpaid / not yet sent"
            value={money(grandUnpaid, 'PHP')}
            tone={grandUnpaid > 0 ? 'warn' : 'good'}
          />
          <StatTile label="Pay periods recorded" value={periods.length} />
        </div>
      </div>

      {/* ---- 2. Payout by pay period ---- */}
      <div className="card">
        <h2>Payout by pay period</h2>
        {periods.length > 0 && (
          <div style={{ margin: '6px 0 10px' }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                alignItems: 'center',
              }}
            >
              <span className="muted" style={{ fontSize: 11, width: 46 }}>
                Year
              </span>
              <button
                type="button"
                className={`btn sm ${fYears.size === 0 ? '' : 'ghost'}`}
                onClick={() => setFYears(new Set())}
              >
                All
              </button>
              {yearsAvail.map((y) => (
                <button
                  key={y}
                  type="button"
                  className={`btn sm ${fYears.has(y) ? '' : 'ghost'}`}
                  onClick={() => toggleSet(fYears, setFYears, y)}
                >
                  {y}
                </button>
              ))}
            </div>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                alignItems: 'center',
                marginTop: 6,
              }}
            >
              <span className="muted" style={{ fontSize: 11, width: 46 }}>
                Month
              </span>
              <button
                type="button"
                className={`btn sm ${fMonths.size === 0 ? '' : 'ghost'}`}
                onClick={() => setFMonths(new Set())}
              >
                All
              </button>
              {MONTHS.map(([n, lbl]) => (
                <button
                  key={n}
                  type="button"
                  className={`btn sm ${fMonths.has(n) ? '' : 'ghost'}`}
                  // Single-select: pick one month (click the active one again → All).
                  onClick={() =>
                    setFMonths(fMonths.has(n) && fMonths.size === 1 ? new Set() : new Set([n]))
                  }
                >
                  {lbl}
                </button>
              ))}
            </div>
            {filterActive && (
              <p className="sub" style={{ marginTop: 6 }}>
                Showing <b>{shown.length}</b> of {periods.length} periods · net{' '}
                <b>{money(fNet, 'PHP')}</b> · ≈ {money(fUsd, 'USD')}
                {shownNoFx > 0 ? ` (${shownNoFx} without FX excluded)` : ''}{' '}
                <button
                  type="button"
                  className="btn link sm"
                  onClick={() => {
                    setFYears(new Set());
                    setFMonths(new Set());
                  }}
                >
                  clear
                </button>
              </p>
            )}
          </div>
        )}
        {periods.length === 0 ? (
          <div className="empty">No saved pay statements yet. Run &amp; lock a payroll first.</div>
        ) : shown.length === 0 ? (
          <div className="empty">No periods match this Year/Month filter.</div>
        ) : (
          <div className="table-scroll">
            <table aria-label="Payout by pay period">
              <thead>
                <tr>
                  <th scope="col" style={{ width: 24 }} />
                  <th scope="col">Period</th>
                  <th scope="col">Pay date</th>
                  <th scope="col">Contractors</th>
                  <th scope="col">Net ₱</th>
                  <th
                    scope="col"
                    title="USD reference only — contractors are paid in PHP. Computed as Net ₱ ÷ FX. FX is the rate Wise locked at transfer time (USD→PHP) where available, otherwise a market approximation."
                  >
                    ≈ USD ref
                  </th>
                  <th scope="col">Unpaid ₱</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => {
                  const open = openKey === p.key;
                  return (
                    <Fragment key={p.key}>
                      <tr
                        className="clickable"
                        tabIndex={0}
                        aria-expanded={open}
                        onClick={() => setOpenKey(open ? null : p.key)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setOpenKey(open ? null : p.key);
                          }
                        }}
                        style={{
                          cursor: 'pointer',
                          background: open ? '#f1f5f9' : undefined,
                        }}
                      >
                        <td data-label="Details" style={{ color: 'var(--muted)' }}>
                          {open ? '▾' : '▸'}
                        </td>
                        <td className="card-title">
                          {p.start} → {p.end}
                        </td>
                        <td data-label="Pay date">{p.payDate || '—'}</td>
                        <td data-label="Contractors">{p.count}</td>
                        <td data-label="Net ₱">
                          <b>{money(p.net, 'PHP')}</b>
                        </td>
                        <td className="muted" data-label="≈ USD ref">
                          {p.fx ? money(p.usdRef, 'USD') : '—'}
                        </td>
                        <td
                          data-label="Unpaid ₱"
                          style={p.unpaid > 0 ? { color: 'var(--warn)', fontWeight: 600 } : {}}
                        >
                          {money(p.unpaid, 'PHP')}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td
                            colSpan={nCols}
                            style={{
                              background: 'var(--surface-2)',
                              padding: '8px 10px',
                            }}
                          >
                            <div style={{ maxHeight: 320, overflow: 'auto' }}>
                              <table
                                className="keep-table"
                                aria-label="Per-contractor breakdown for this pay period"
                              >
                                <thead>
                                  <tr>
                                    <th scope="col">Contractor</th>
                                    <th scope="col">Hours</th>
                                    <th scope="col">Rate ₱</th>
                                    <th scope="col">Gross ₱</th>
                                    <th scope="col">Health ₱</th>
                                    <th scope="col">13th ₱</th>
                                    <th scope="col">Lunch ₱</th>
                                    <th scope="col">Bonus ₱</th>
                                    <th scope="col">Misc earn ₱</th>
                                    <th scope="col">
                                      <span
                                        className="tip-wrap"
                                        // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the hover tooltip is keyboard-reachable (legacy tip-wrap)
                                        tabIndex={0}
                                        style={{ cursor: 'help' }}
                                      >
                                        Deductions ₱
                                        <span className="tip-body">
                                          User-entered deductions (Misc popup) — actually subtracted
                                          from Net.
                                        </span>
                                      </span>
                                    </th>
                                    <th scope="col">
                                      <span
                                        className="tip-wrap"
                                        // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the hover tooltip is keyboard-reachable (legacy tip-wrap)
                                        tabIndex={0}
                                        style={{ cursor: 'help' }}
                                      >
                                        Perf. short ₱
                                        <span className="tip-body">
                                          Performance shortfall = rate − gross when hours were under
                                          expectation. Informational only — NOT subtracted from Net.
                                        </span>
                                      </span>
                                    </th>
                                    <th scope="col">Net ₱</th>
                                    <th scope="col">Method</th>
                                    <th scope="col">Status</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {[...p.rows]
                                    .sort((a, b) => a.name.localeCompare(b.name))
                                    .map((r) => (
                                      <tr key={`${p.key}-${r.name}`}>
                                        <td>
                                          <b>{r.name}</b>
                                        </td>
                                        <td>
                                          {r.hours != null ? Number(r.hours).toFixed(2) : '—'}
                                        </td>
                                        <td>{money(r.rate, 'PHP')}</td>
                                        <td>{money(r.gross, 'PHP')}</td>
                                        <td>{money(r.ha, 'PHP')}</td>
                                        <td>{money(r.t13, 'PHP')}</td>
                                        <td>{money(r.lunch, 'PHP')}</td>
                                        <td>{money(r.bonus, 'PHP')}</td>
                                        <td>{r.miscEarn ? money(r.miscEarn, 'PHP') : '—'}</td>
                                        <td style={r.miscDeduct ? { color: 'var(--bad)' } : {}}>
                                          {r.miscDeduct ? `-${money(r.miscDeduct, 'PHP')}` : '—'}
                                        </td>
                                        <td className="muted">
                                          {r.perfShort ? money(r.perfShort, 'PHP') : '—'}
                                        </td>
                                        <td>
                                          <b>{money(r.net, 'PHP')}</b>
                                        </td>
                                        <td>{payoutMethodLabel(r.method) || '—'}</td>
                                        <td>
                                          <span
                                            className="pill"
                                            style={
                                              PAID(r.status)
                                                ? {
                                                    background: 'var(--good-soft)',
                                                    color: 'var(--good)',
                                                  }
                                                : {
                                                    background: '#f3f4f6',
                                                    color: 'var(--muted)',
                                                  }
                                            }
                                          >
                                            {PAID(r.status) ? 'paid' : r.status || 'draft'}
                                          </span>
                                        </td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PerContractorSummary data={data} />

      <ContractorHistory companyId={companyId} workers={data.workers} />

      <UtilizationReport companyId={companyId} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// 3. Contractor Pay Summary
// ---------------------------------------------------------------------------

const PerContractorSummary = ({ data }: { data: ReportsData }) => {
  const yr = new Date().getFullYear();
  const [from, setFrom] = useState(`${yr}-01-01`);
  const [to, setTo] = useState('');
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);

  // Contractor options = everyone with at least one statement in the window.
  const pickOptions = data.summary
    .filter((g) =>
      g.statements.some((s) => {
        if (!s.start) return false;
        if (from && s.start < from) return false;
        if (to && s.start > to) return false;
        return true;
      }),
    )
    .map((g) => ({ id: g.workerId, name: g.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Re-aggregate the selected contractors within the [from,to] window (by
  // period_start). Mirrors the legacy in-browser filtering.
  const rows = data.summary
    .filter((g) => sel.has(g.workerId))
    .map((g) => {
      const statements = g.statements.filter((s) => {
        if (!s.start) return false;
        if (from && s.start < from) return false;
        if (to && s.start > to) return false;
        return true;
      });
      const agg = statements.reduce(
        (acc, s) => {
          acc.periods++;
          acc.hours += s.hours;
          acc.gross += s.gross;
          acc.ha += s.ha;
          acc.t13 += s.t13;
          acc.lunch += s.lunch;
          acc.bonus += s.bonus;
          acc.misc += s.misc;
          acc.ded += s.ded;
          acc.net += s.net;
          if (PAID(s.status)) acc.paid += s.net;
          return acc;
        },
        {
          periods: 0,
          hours: 0,
          gross: 0,
          ha: 0,
          t13: 0,
          lunch: 0,
          bonus: 0,
          misc: 0,
          ded: 0,
          net: 0,
          paid: 0,
        },
      );
      return { ...g, ...agg, statements };
    })
    .filter((g) => g.statements.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const totNet = rows.reduce((s, r) => s + r.net, 0);
  const stmtCount = rows.reduce((n, r) => n + r.statements.length, 0);

  const exportCsv = () => {
    const header = [
      'Contractor',
      'Periods',
      'Hours',
      'Gross PHP',
      'Health PHP',
      '13th PHP',
      'Lunch PHP',
      'Bonus PHP',
      'Misc PHP (net)',
      'Perf short PHP',
      'Net PHP',
      'Paid PHP',
    ];
    const body = rows.map((r) => [
      r.name,
      r.periods,
      num(r.hours),
      num(r.gross),
      num(r.ha),
      num(r.t13),
      num(r.lunch),
      num(r.bonus),
      num(r.misc),
      num(r.ded),
      num(r.net),
      num(r.paid),
    ]);
    downloadCSV(`contractor_summary_${from || 'start'}_${to || 'latest'}.csv`, [header, ...body]);
  };

  const exportStatements = () => {
    const header = [
      'Contractor',
      'Period start',
      'Period end',
      'Pay date',
      'Hours',
      'Gross PHP',
      'Health PHP',
      '13th PHP',
      'Lunch PHP',
      'Bonus PHP',
      'Misc PHP (net)',
      'Perf short PHP',
      'Net PHP',
      'Status',
    ];
    const body: Array<Array<string | number | null | undefined>> = [];
    for (const r of rows) {
      for (const s of r.statements) {
        body.push([
          r.name,
          s.start,
          s.end,
          s.payDate,
          num(s.hours),
          num(s.gross),
          num(s.ha),
          num(s.t13),
          num(s.lunch),
          num(s.bonus),
          num(s.misc),
          num(s.ded),
          num(s.net),
          s.status || '',
        ]);
      }
    }
    downloadCSV(`contractor_statements_${from || 'start'}_${to || 'latest'}.csv`, [
      header,
      ...body,
    ]);
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Contractor Pay Summary</h2>
          <p className="sub">
            Totals per selected contractor over a date range (by period start). For year-end
            statements, visa/mortgage letters, and quick "how much did we pay X" lookups.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn ghost sm"
            disabled={!rows.length}
            onClick={exportCsv}
          >
            Summary CSV ({rows.length})
          </button>
          <button
            type="button"
            className="btn ghost sm"
            disabled={!stmtCount}
            onClick={exportStatements}
          >
            Statements CSV ({stmtCount})
          </button>
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          margin: '8px 0',
        }}
      >
        <div>
          <label htmlFor="rpt-summary-from" style={{ fontSize: 10, color: 'var(--muted)' }}>
            From (period start)
          </label>
          <br />
          <input
            id="rpt-summary-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="rpt-summary-to" style={{ fontSize: 10, color: 'var(--muted)' }}>
            To
          </label>
          <br />
          <input
            id="rpt-summary-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: caption above the contractor picker (legacy markup) */}
          <label
            style={{
              fontSize: 10,
              color: 'var(--muted)',
              display: 'block',
              marginBottom: 2,
            }}
          >
            Contractors
          </label>
          <ContractorPicker
            options={pickOptions}
            value={sel}
            onChange={setSel}
            placeholder="Select…"
          />
        </div>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            setFrom(`${yr}-01-01`);
            setTo('');
          }}
        >
          This year
        </button>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            setFrom(`${yr - 1}-01-01`);
            setTo(`${yr - 1}-12-31`);
          }}
        >
          Last year
        </button>
        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto', alignSelf: 'center' }}>
          {rows.length} contractor(s) · total net {money(totNet, 'PHP')}
        </span>
      </div>
      {sel.size === 0 ? (
        <div className="empty">
          Pick one or more contractors above (or “Select all”) to see their pay summary.
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">No pay statements for the selected contractor(s) in this range.</div>
      ) : (
        <div className="table-scroll">
          <table aria-label="Contractor pay summary totals">
            <thead>
              <tr>
                <th scope="col">Contractor</th>
                <th scope="col">Periods</th>
                <th scope="col">Hours</th>
                <th scope="col">Gross ₱</th>
                <th scope="col">Misc ₱</th>
                <th scope="col">Net ₱</th>
                <th scope="col">Paid ₱</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const open = openKey === r.gkey;
                return (
                  <Fragment key={r.gkey}>
                    <tr
                      className="clickable"
                      tabIndex={0}
                      aria-expanded={open}
                      onClick={() => setOpenKey(open ? null : r.gkey)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setOpenKey(open ? null : r.gkey);
                        }
                      }}
                      style={{
                        cursor: 'pointer',
                        background: open ? '#f1f5f9' : undefined,
                      }}
                    >
                      <td className="card-title">
                        <span style={{ color: 'var(--muted)', marginRight: 6 }}>
                          {open ? '▾' : '▸'}
                        </span>
                        <b>{r.name}</b>
                      </td>
                      <td data-label="Periods">{r.periods}</td>
                      <td data-label="Hours">{num(r.hours)}</td>
                      <td data-label="Gross ₱">{money(r.gross, 'PHP')}</td>
                      <td data-label="Misc ₱" style={r.misc < 0 ? { color: 'var(--bad)' } : {}}>
                        {money(r.misc, 'PHP')}
                      </td>
                      <td data-label="Net ₱">
                        <b>{money(r.net, 'PHP')}</b>
                      </td>
                      <td
                        data-label="Paid ₱"
                        style={r.paid < r.net ? { color: 'var(--warn)' } : { color: 'var(--good)' }}
                      >
                        {money(r.paid, 'PHP')}
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td
                          colSpan={7}
                          style={{ background: 'var(--surface-2)', padding: '8px 10px' }}
                        >
                          <div className="sub" style={{ margin: '0 0 6px' }}>
                            Individual pay statements ({r.statements.length}) — each pay period that
                            makes up the totals above.
                          </div>
                          <table
                            className="keep-table"
                            aria-label="Individual pay statements for this contractor"
                          >
                            <thead>
                              <tr>
                                <th scope="col">Pay period</th>
                                <th scope="col">Pay date</th>
                                <th scope="col">Hours</th>
                                <th scope="col">Gross ₱</th>
                                <th scope="col">Health ₱</th>
                                <th scope="col">13th ₱</th>
                                <th scope="col">Lunch ₱</th>
                                <th scope="col">Bonus ₱</th>
                                <th scope="col">Misc ₱</th>
                                <th scope="col">Net ₱</th>
                                <th scope="col">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.statements.map((s) => {
                                const isPaid = PAID(s.status);
                                return (
                                  <tr key={`${r.gkey}-${s.start}-${s.end || ''}`}>
                                    <td>
                                      {s.start} → {s.end || '?'}
                                    </td>
                                    <td className="muted">{s.payDate || '—'}</td>
                                    <td>{num(s.hours)}</td>
                                    <td>{money(s.gross, 'PHP')}</td>
                                    <td>{s.ha ? money(s.ha, 'PHP') : '—'}</td>
                                    <td>{s.t13 ? money(s.t13, 'PHP') : '—'}</td>
                                    <td>{s.lunch ? money(s.lunch, 'PHP') : '—'}</td>
                                    <td>{s.bonus ? money(s.bonus, 'PHP') : '—'}</td>
                                    <td style={s.misc < 0 ? { color: 'var(--bad)' } : {}}>
                                      {s.misc ? money(s.misc, 'PHP') : '—'}
                                    </td>
                                    <td>
                                      <b>{money(s.net, 'PHP')}</b>
                                    </td>
                                    <td>
                                      <span
                                        className="pill"
                                        style={
                                          isPaid
                                            ? {
                                                background: 'var(--good-soft)',
                                                color: 'var(--good)',
                                              }
                                            : {
                                                background: '#f3f4f6',
                                                color: 'var(--muted)',
                                              }
                                        }
                                      >
                                        {isPaid ? 'paid' : s.status || 'draft'}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Click a contractor to expand their individual pay statements per period. <b>Summary CSV</b>{' '}
        is the condensed per-contractor totals; <b>Statements CSV</b> is one row per pay period (the
        full breakdown: Health, 13th, Lunch, Bonus, Deductions). Gross + Misc + the other components
        reconcile to Net.
      </p>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 4. Contractor pay & hours history
// ---------------------------------------------------------------------------

const ContractorHistory = ({
  companyId,
  workers,
}: {
  companyId: string;
  workers: Array<{ id: string; name: string }>;
}) => {
  const [wid, setWid] = useState('');
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [openKey, setOpenKey] = useState<number | null>(null);
  const [loading, startLoad] = useTransition();

  const loadHistory = (id: string) => {
    setWid(id);
    setOpenKey(null);
    if (!id) {
      setRows(null);
      return;
    }
    startLoad(async () => {
      const res = await getContractorHistory(companyId, id);
      setRows(res.ok ? res.data.rows : []);
    });
  };

  const sel = workers.find((w) => w.id === wid);

  const exportCsv = () => {
    if (!rows?.length) return;
    const header = [
      'Period start',
      'Period end',
      'Worked h',
      'PTO h',
      'Health PHP',
      'Lunch PHP',
      '13th PHP',
      'Gross PHP',
      'Net PHP',
      'Method',
      'Status',
    ];
    const body = rows.map((r) => [
      r.start,
      r.end || '',
      r.worked != null ? r.worked.toFixed(2) : '',
      r.pto.toFixed(2),
      r.hasPay ? r.ha : '',
      r.hasPay ? r.lunch : '',
      r.hasPay ? r.t13 : '',
      r.hasPay ? r.gross : '',
      r.hasPay ? r.net : '',
      r.method || '',
      r.status || '',
    ]);
    downloadCSV(`${(sel?.name || 'contractor').replace(/[^a-z0-9]+/gi, '_')}_history.csv`, [
      header,
      ...body,
    ]);
  };

  const fmtD = (d: string): string => {
    try {
      return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return d;
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Contractor pay &amp; hours history</h2>
          <p className="sub">
            Pick a contractor to see every pay period's worked hours, PTO, and pay components
            stacked. Hours/PTO come from time entries; amounts from saved pay statements.
          </p>
        </div>
        {rows && rows.length > 0 && (
          <button type="button" className="btn ghost sm" onClick={exportCsv}>
            Export CSV ({rows.length})
          </button>
        )}
      </div>
      <select
        aria-label="Select contractor for pay and hours history"
        value={wid}
        onChange={(e) => loadHistory(e.target.value)}
        style={{ maxWidth: 340, margin: '6px 0' }}
      >
        <option value="">Select contractor…</option>
        {workers.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      {!wid ? null : rows === null || loading ? (
        <div className="empty">Loading…</div>
      ) : !rows.length ? (
        <div className="empty">No hours or pay records for this contractor.</div>
      ) : (
        <div className="table-scroll">
          <table aria-label="Contractor pay and hours history">
            <thead>
              <tr>
                <th scope="col">Pay period</th>
                <th scope="col">Worked h</th>
                <th scope="col">PTO h</th>
                <th scope="col">Health ₱</th>
                <th scope="col">Lunch ₱</th>
                <th scope="col">13th ₱</th>
                <th scope="col">Gross ₱</th>
                <th scope="col">Net ₱</th>
                <th scope="col">Method</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const open = openKey === i;
                const hasDays = r.days && r.days.length > 0;
                return (
                  <Fragment key={`${r.start}-${r.end || ''}`}>
                    <tr
                      className={hasDays ? 'clickable' : undefined}
                      tabIndex={hasDays ? 0 : undefined}
                      aria-expanded={hasDays ? open : undefined}
                      onClick={() => hasDays && setOpenKey(open ? null : i)}
                      onKeyDown={(e) => {
                        if (hasDays && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          setOpenKey(open ? null : i);
                        }
                      }}
                      style={{
                        cursor: hasDays ? 'pointer' : 'default',
                        background: open ? '#f1f5f9' : undefined,
                      }}
                    >
                      <td className="card-title">
                        <span style={{ color: 'var(--muted)', marginRight: 6 }}>
                          {hasDays ? (open ? '▾' : '▸') : ' '}
                        </span>
                        {r.start} → {r.end || '?'}
                      </td>
                      <td data-label="Worked h">{r.worked != null ? r.worked.toFixed(2) : '—'}</td>
                      <td data-label="PTO h">{r.pto > 0 ? r.pto.toFixed(2) : '—'}</td>
                      <td data-label="Health ₱">{r.hasPay ? money(r.ha, 'PHP') : '—'}</td>
                      <td data-label="Lunch ₱">{r.hasPay ? money(r.lunch, 'PHP') : '—'}</td>
                      <td data-label="13th ₱">{r.hasPay && r.t13 ? money(r.t13, 'PHP') : '—'}</td>
                      <td data-label="Gross ₱">{r.hasPay ? money(r.gross, 'PHP') : '—'}</td>
                      <td data-label="Net ₱">
                        <b>{r.hasPay ? money(r.net, 'PHP') : '—'}</b>
                      </td>
                      <td data-label="Method">
                        {r.hasPay ? payoutMethodLabel(r.method) || '—' : '—'}
                      </td>
                      <td data-label="Status">
                        {r.hasPay ? (
                          <span
                            className="pill"
                            style={
                              PAID(r.status)
                                ? { background: 'var(--good-soft)', color: 'var(--good)' }
                                : {
                                    background: '#f3f4f6',
                                    color: 'var(--muted)',
                                  }
                            }
                          >
                            {PAID(r.status) ? 'paid' : r.status || 'draft'}
                          </span>
                        ) : (
                          <span className="muted" style={{ fontSize: 11 }}>
                            time only
                          </span>
                        )}
                      </td>
                    </tr>
                    {open && hasDays && (
                      <tr>
                        <td
                          colSpan={10}
                          style={{ background: 'var(--surface-2)', padding: '8px 10px' }}
                        >
                          <div>
                            <table
                              className="keep-table"
                              aria-label="Per-day worked and PTO hours for this pay period"
                            >
                              <thead>
                                <tr>
                                  <th scope="col">Day</th>
                                  <th scope="col">Worked h</th>
                                  <th scope="col">PTO h</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.days.map((d) => (
                                  <tr key={d.date}>
                                    <td>
                                      {fmtD(d.date)}{' '}
                                      <span className="muted" style={{ fontSize: 11 }}>
                                        ({d.date})
                                      </span>
                                    </td>
                                    <td>{(d.tracked / 3600).toFixed(2)}</td>
                                    <td>{d.pto > 0 ? (d.pto / 3600).toFixed(2) : '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 5. Avg. Weekly Activity (Utilization)
// ---------------------------------------------------------------------------

const UtilizationReport = ({ companyId }: { companyId: string }) => {
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [options, setOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [rows, setRows] = useState<UtilizationRow[]>([]);
  const [anyActivity, setAnyActivity] = useState(false);
  const [loading, startLoad] = useTransition();

  // Load the contractor options once (empty selection => options only).
  useEffect(() => {
    let cancel = false;
    (async () => {
      const res = await getUtilization(companyId, []);
      if (cancel) return;
      if (res.ok) setOptions(res.data.contractors);
    })();
    return () => {
      cancel = true;
    };
  }, [companyId]);

  const onPick = (next: Set<string>) => {
    setSel(next);
    if (next.size === 0) {
      setRows([]);
      setAnyActivity(false);
      return;
    }
    startLoad(async () => {
      const res = await getUtilization(companyId, [...next]);
      if (res.ok) {
        setRows(res.data.rows);
        setAnyActivity(res.data.anyActivity);
      }
    });
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Avg. Weekly Activity</h2>
          <p className="sub">
            Average Hubstaff activity % per contractor per week (Mon–Sun), from approved time.
          </p>
        </div>
        <div>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: caption above the contractor picker (legacy markup) */}
          <label
            style={{
              fontSize: 10,
              color: 'var(--muted)',
              display: 'block',
              marginBottom: 2,
            }}
          >
            Contractors
          </label>
          <ContractorPicker options={options} value={sel} onChange={onPick} placeholder="Select…" />
        </div>
      </div>
      {loading ? (
        <div className="empty">Loading…</div>
      ) : sel.size === 0 ? (
        <div className="empty">
          Pick one or more contractors above to see their weekly activity.
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">No approved time for the selected contractor(s).</div>
      ) : !anyActivity ? (
        <div className="empty">
          No Hubstaff activity % is synced for the selected contractor(s) yet — it appears here once
          a Hubstaff API sync captures it (historical imports were hours-only).
        </div>
      ) : (
        <div className="table-scroll">
          <table aria-label="Average weekly activity">
            <thead>
              <tr>
                <th scope="col">Contractor</th>
                <th scope="col">Week of</th>
                <th scope="col">Avg activity</th>
                <th scope="col">Hours</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.workerId}-${r.week}`}>
                  <td className="card-title">
                    <b>{r.name}</b>
                  </td>
                  <td data-label="Week of">{r.week}</td>
                  <td data-label="Avg activity">{r.act == null ? '—' : `${r.act}%`}</td>
                  <td data-label="Hours">{r.hours}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
