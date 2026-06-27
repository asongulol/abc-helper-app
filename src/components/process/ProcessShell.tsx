/**
 * ProcessShell — the legacy "Process payroll" view (index.html ~9616).
 *
 * Renders the heading + intro, then either:
 *  - a LIST of locked-but-not-yet-paid batches ("ready to pay"), or
 *  - the empty state + "Waiting upstream" banner when none are ready.
 *
 * This is the Process & Pay tab's first render — the per-period pay detail
 * (Summary / Wise drafts / mark paid) lives behind "Open & pay" in Calculate.
 */

import Link from 'next/link';

export interface ReadyPeriod {
  id: string;
  periodStart: string;
  periodEnd: string;
  payDate: string | null;
}

export interface DraftRef {
  start: string;
  end: string;
}

interface ProcessShellProps {
  /** Locked, not-yet-paid batches (legacy `ready`). */
  ready: ReadyPeriod[];
  /** Open periods with calculated drafts, not yet locked (legacy `prep.drafts`). */
  drafts: DraftRef[];
  /** Pending time entries in Time & Approval (legacy `prep.pending`). */
  pending: number;
}

export const ProcessShell = ({ ready, drafts, pending }: ProcessShellProps) => (
  <div>
    <div className="card">
      <h2>Process payroll</h2>
      <p className="sub">
        After a period is locked, pay people here. Choose a locked period, then use a manual Wise
        batch file, individual payment files, or the automatic Wise API draft below.{' '}
        <b>Contractors are paid in PHP.</b>
      </p>

      {ready.length === 0 ? (
        <div className="empty" style={{ textAlign: 'left' }}>
          <p style={{ margin: '0 0 8px' }}>
            <b>No payrolls ready to process and pay.</b> Go to {/* */}
            <b>Time &amp; Approval</b> to import time, or review approved batches in the {/* */}
            <b>Calculate</b> tab.
          </p>
          {(pending > 0 || drafts.length > 0) && (
            <div
              className="banner"
              style={{
                background: '#eff6ff',
                borderColor: '#bfdbfe',
                color: '#1e3a8a',
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <span>
                Waiting upstream:
                {drafts.length > 0 && (
                  <>
                    {' '}
                    <b>{drafts.length}</b> calculated draft(s) not yet locked{' '}
                    {`(${drafts
                      .slice(0, 3)
                      .map((d) => `${d.start}→${d.end}`)
                      .join(', ')}${drafts.length > 3 ? ', …' : ''})`}
                  </>
                )}
                {drafts.length > 0 && pending > 0 && ' · '}
                {pending > 0 && (
                  <>
                    {' '}
                    <b>{pending}</b> pending time entr(ies) in Time &amp; Approval
                  </>
                )}
                .
              </span>
              {drafts.length > 0 && (
                <Link className="btn sm" href={`/payroll?period=${drafts[0]?.start}`}>
                  Go to Calculate
                </Link>
              )}
              {pending > 0 && (
                <Link className="btn ghost sm" href="/time">
                  Go to Time &amp; Approval
                </Link>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="table-scroll" style={{ marginTop: 4 }}>
          <table>
            <thead>
              <tr>
                <th>Pay period</th>
                <th>Pay date</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ready.map((p) => (
                <tr key={p.id}>
                  <td className="card-title">
                    <b>
                      {p.periodStart} → {p.periodEnd}
                    </b>
                  </td>
                  <td data-label="Pay date">{p.payDate || '—'}</td>
                  <td data-label="Status">
                    <span className="pill" style={{ background: '#eef2ff', color: '#3730a3' }}>
                      locked · ready to pay
                    </span>
                  </td>
                  <td className="card-action" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Link className="btn sm" href={`/payroll?period=${p.periodStart}`}>
                      Open &amp; pay
                    </Link>{' '}
                    <Link
                      className="btn ghost sm"
                      href={`/payroll?period=${p.periodStart}&unlock=1`}
                      title="Flip back to a draft and return to Calculate for editing. Requires a reason."
                    >
                      Unlock
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  </div>
);
