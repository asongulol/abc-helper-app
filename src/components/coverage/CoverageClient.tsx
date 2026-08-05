'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge, type BadgeTone, useToast } from '@/components/ui';
import type { CoverageRosterRow } from '@/db/queries/coverage';
import type { CoverageStatus } from '@/lib/coverage/classify';
import { fmtDate, hours } from '@/lib/format';
import { clearCoverageTarget, setCoverageTarget } from '@/server/actions/coverage';

interface Props {
  companyId: string;
  roster: CoverageRosterRow[];
  period: { start: string; end: string };
}

const rightAlign = { textAlign: 'right' } as const;
const subCell = { fontSize: 11, color: 'var(--muted)' } as const;

/** The stored target as the input renders it — the baseline "is this row edited?" compares against. */
const storedDraft = (r: CoverageRosterRow): string =>
  r.targetHours != null ? String(r.targetHours) : '';

const STATUS_TONE: Record<CoverageStatus, BadgeTone> = {
  zero_time: 'bad',
  under_coverage: 'warn',
  on_track: 'good',
  not_measured: 'neutral',
};

const statusLabel = (r: CoverageRosterRow): string => {
  if (r.status === 'not_measured') return r.tracked ? 'No target' : 'Not tracked';
  if (r.status === 'zero_time') return 'No time';
  return `${Math.round(((r.workedHours + r.ptoHours) / r.expectedHours) * 100)}%`;
};

const statusHint = (r: CoverageRosterRow): string => {
  if (!r.tracked)
    return 'No Hubstaff identity on this link — can never log time, so never counted.';
  if (r.status === 'not_measured')
    return 'No target and no weekly hours — nothing to measure against.';
  if (r.status === 'zero_time') return 'Expected to work this period but recorded nothing.';
  if (r.status === 'under_coverage') return 'Below 60% of expected — flagged on the Overview.';
  return 'At or above 60% of expected.';
};

export const CoverageClient = ({ companyId, roster, period }: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [busy, start] = useTransition();
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(roster.map((r) => [r.workerId, storedDraft(r)])),
  );

  const measured = roster.filter((r) => r.expectedHours > 0);
  const gaps = measured.filter((r) => r.status === 'zero_time' || r.status === 'under_coverage');
  const untracked = roster.filter((r) => !r.tracked);
  const span = `${fmtDate(period.start)} – ${fmtDate(period.end)}`;

  const clear = (workerId: string) => {
    start(async () => {
      const res = await clearCoverageTarget({ companyId, workerId });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify('Target cleared — back to the default for this period.', { type: 'success' });
      setDrafts((d) => ({ ...d, [workerId]: '' }));
      router.refresh();
    });
  };

  const save = (r: CoverageRosterRow) => {
    const raw = (drafts[r.workerId] ?? '').trim();
    // Blank means "use the default" — the same intent the old Clear button carried,
    // without a second button that only ever appeared on half the rows.
    if (raw === '') {
      if (!r.targetId) {
        notify('Already using the default for this contractor.', { type: 'warn' });
        return;
      }
      clear(r.workerId);
      return;
    }
    const target = Number(raw);
    if (!Number.isFinite(target) || target < 0) {
      notify('Enter hours (0 or more), or empty the box to use the default.', { type: 'warn' });
      return;
    }
    start(async () => {
      const res = await setCoverageTarget({
        companyId,
        workerId: r.workerId,
        targetHours: target,
        periodKind: 'semi_monthly',
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(`Target saved — ${r.workerName} is now measured against ${hours(target)}.`, {
        type: 'success',
      });
      router.refresh();
    });
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Coverage — {span}</h2>
        {measured.length === 0 ? (
          <div className="banner info" style={{ marginBottom: 0 }}>
            <span>
              Nothing is being measured this period — no contractor has a target or weekly hours
              set, so the Overview cannot flag anyone. Set a target below to start measuring.
            </span>
          </div>
        ) : (
          <p className="sub" style={{ marginBottom: 8 }}>
            <strong style={{ color: gaps.length ? 'var(--warn)' : 'var(--good)' }}>
              {gaps.length === 0
                ? `All ${measured.length} measured contractors are on track.`
                : `${gaps.length} of ${measured.length} measured contractors are under expected hours.`}
            </strong>
            {untracked.length > 0 &&
              ` ${untracked.length} more ${untracked.length === 1 ? 'is' : 'are'} not time-tracked and cannot be measured at all.`}
          </p>
        )}
        <p className="sub" style={{ marginBottom: 0 }}>
          A target is the hours a contractor is expected to cover per pay period; the Overview flags
          anyone below 60% of it. Tracked time and approved PTO both count. Leave a target empty to
          use the default — their weekly hours × the weeks in this period.
        </p>
      </div>

      <div className="card">
        {roster.length === 0 ? (
          <p className="sub">No active contractors for this company.</p>
        ) : (
          <div className="table-scroll">
            <table aria-label="Coverage by contractor">
              <thead>
                <tr>
                  <th scope="col">Contractor</th>
                  <th scope="col" style={rightAlign}>
                    Covered
                  </th>
                  <th scope="col" style={rightAlign}>
                    Expected
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col" style={rightAlign}>
                    Target / period (hrs)
                  </th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((r) => {
                  const edited = (drafts[r.workerId] ?? '') !== storedDraft(r);
                  return (
                    <tr key={r.workerId}>
                      <td>{r.workerName}</td>
                      <td style={rightAlign}>
                        {hours(r.workedHours)}
                        {r.ptoHours > 0 && <div style={subCell}>+ {hours(r.ptoHours)} PTO</div>}
                      </td>
                      <td style={rightAlign}>
                        {r.expectedHours > 0 ? hours(r.expectedHours) : '—'}
                        {r.expectedHours > 0 && (
                          <div style={subCell}>{r.targetHours != null ? 'custom' : 'default'}</div>
                        )}
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[r.status]} title={statusHint(r)}>
                          {statusLabel(r)}
                        </Badge>
                      </td>
                      <td style={rightAlign}>
                        <input
                          type="number"
                          min="0"
                          step="0.5"
                          style={{ width: 90, textAlign: 'right' }}
                          aria-label={`Target hours for ${r.workerName}`}
                          value={drafts[r.workerId] ?? ''}
                          placeholder={
                            r.defaultHours != null
                              ? String(Math.round(r.defaultHours * 10) / 10)
                              : '—'
                          }
                          onChange={(e) =>
                            setDrafts((d) => ({ ...d, [r.workerId]: e.target.value }))
                          }
                        />
                      </td>
                      <td>
                        {/* Only the row you actually changed offers a Save — 20 idle
                            buttons read as 20 pending actions. */}
                        {edited && (
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy}
                            onClick={() => save(r)}
                          >
                            Save
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
};
