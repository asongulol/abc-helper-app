'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useToast } from '@/components/ui';
import type { CoverageRosterRow } from '@/db/queries/coverage';
import { clearCoverageTarget, setCoverageTarget } from '@/server/actions/coverage';

interface Props {
  companyId: string;
  roster: CoverageRosterRow[];
}

const rightAlign = { textAlign: 'right' } as const;

export const CoverageClient = ({ companyId, roster }: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [busy, start] = useTransition();
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      roster.map((r) => [r.workerId, r.targetHours != null ? String(r.targetHours) : '']),
    ),
  );

  const save = (workerId: string) => {
    const raw = drafts[workerId] ?? '';
    const hours = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(hours) || hours < 0) {
      notify('Enter a target in hours (≥ 0), or use Clear.', { type: 'warn' });
      return;
    }
    start(async () => {
      const res = await setCoverageTarget({
        companyId,
        workerId,
        targetHours: hours,
        periodKind: 'semi_monthly',
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify('Coverage target saved.', { type: 'success' });
      router.refresh();
    });
  };

  const clear = (workerId: string) => {
    start(async () => {
      const res = await clearCoverageTarget({ companyId, workerId });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify('Target cleared — using weekly hours.', { type: 'success' });
      setDrafts((d) => ({ ...d, [workerId]: '' }));
      router.refresh();
    });
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Coverage targets</h2>
        <p className="sub">
          Expected hours per pay period for each contractor — the Overview flags anyone whose
          tracked time falls short. Leave a target blank (Clear) to fall back to the
          contractor&apos;s weekly hours × weeks in the period.
        </p>
      </div>

      <div className="card">
        {roster.length === 0 ? (
          <p className="sub">No active contractors for this company.</p>
        ) : (
          <div className="table-scroll">
            <table aria-label="Coverage targets by contractor">
              <thead>
                <tr>
                  <th scope="col">Contractor</th>
                  <th scope="col" style={rightAlign}>
                    Weekly hours
                  </th>
                  <th scope="col" style={rightAlign}>
                    Target / period (hrs)
                  </th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((r) => (
                  <tr key={r.workerId}>
                    <td>{r.workerName}</td>
                    <td style={rightAlign}>{r.weeklyHours != null ? r.weeklyHours : '—'}</td>
                    <td style={rightAlign}>
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        style={{ width: 90, textAlign: 'right' }}
                        aria-label={`Target hours for ${r.workerName}`}
                        value={drafts[r.workerId] ?? ''}
                        placeholder={
                          r.weeklyHours != null ? `~${((r.weeklyHours * 15) / 7).toFixed(0)}` : '—'
                        }
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.workerId]: e.target.value }))}
                      />
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={busy}
                          onClick={() => save(r.workerId)}
                        >
                          Save
                        </button>
                        {r.targetId && (
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={busy}
                            onClick={() => clear(r.workerId)}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
};
