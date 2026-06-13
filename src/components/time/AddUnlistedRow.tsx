'use client';

/**
 * Bottom-of-table row for adding hours for a contractor NOT yet listed in the
 * period. Has a period-date picker that snaps via periodFor (user can target
 * any period, not just the active one). Two modes: total / daily.
 *
 * Faithful to the legacy addManualRow / bottom-row state.
 */

import { useToast } from '@/components/ui';
import { periodDates, periodFor } from '@/lib/dates/periods';
import { addHoursDaily, addHoursTotal } from '@/server/actions/time';
import { useState, useTransition } from 'react';

interface ContractorOption {
  workerId: string;
  displayName: string;
  sourceName: string;
}

interface AddUnlistedRowProps {
  companyId: string;
  contractorOptions: ContractorOption[];
  defaultPeriodStart: string;
  defaultPeriodEnd: string;
  onDone: () => void;
}

export const AddUnlistedRow = ({
  companyId,
  contractorOptions,
  defaultPeriodStart,
  defaultPeriodEnd,
  onDone,
}: AddUnlistedRowProps) => {
  const { notify } = useToast();
  const [selectedWorkerId, setSelectedWorkerId] = useState('');
  const [mpDate, setMpDate] = useState('');
  const [mode, setMode] = useState<'total' | 'daily'>('total');
  const [totalStr, setTotalStr] = useState('');
  const [dailyMap, setDailyMap] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  // Snap the chosen date to its semi-monthly period.
  const effPeriod = mpDate
    ? periodFor(mpDate)
    : { start: defaultPeriodStart, end: defaultPeriodEnd };

  const dates = periodDates(effPeriod.start, effPeriod.end);

  const selectedOption = contractorOptions.find((o) => o.workerId === selectedWorkerId);

  const reset = () => {
    setSelectedWorkerId('');
    setMpDate('');
    setMode('total');
    setTotalStr('');
    setDailyMap({});
  };

  const handleSubmit = () => {
    if (!selectedOption) {
      notify('Pick a contractor.', { type: 'warn' });
      return;
    }
    startTransition(async () => {
      if (mode === 'total') {
        const h = Number.parseFloat(totalStr);
        if (Number.isNaN(h) || h <= 0) {
          notify('Enter a positive number of hours.', { type: 'warn' });
          return;
        }
        const res = await addHoursTotal({
          companyId,
          workerId: selectedOption.workerId,
          sourceName: selectedOption.sourceName,
          periodStart: effPeriod.start,
          hours: h,
        });
        if (!res.ok) {
          notify(res.error, { type: 'error' });
          return;
        }
      } else {
        const days = dates
          .map((date) => ({ date, hours: Number.parseFloat(dailyMap[date] ?? '') || 0 }))
          .filter((d) => d.hours > 0);
        if (days.length === 0) {
          notify('Enter hours for at least one day.', { type: 'warn' });
          return;
        }
        const res = await addHoursDaily({
          companyId,
          workerId: selectedOption.workerId,
          sourceName: selectedOption.sourceName,
          days,
        });
        if (!res.ok) {
          notify(res.error, { type: 'error' });
          return;
        }
      }
      notify(`Hours added for ${selectedOption.displayName}.`, { type: 'success' });
      reset();
      onDone();
    });
  };

  return (
    <tr style={{ background: '#fafafa' }}>
      <td colSpan={9}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
              + Add a contractor not listed above
            </div>
            <select
              value={selectedWorkerId}
              onChange={(e) => setSelectedWorkerId(e.target.value)}
              style={{ maxWidth: 240 }}
              disabled={pending}
            >
              <option value="">Select contractor…</option>
              {contractorOptions.map((o) => (
                <option key={o.workerId} value={o.workerId}>
                  {o.displayName}
                </option>
              ))}
            </select>
          </div>

          {selectedWorkerId && (
            <>
              <div>
                <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>
                  Pay period
                  <input
                    type="date"
                    value={mpDate || effPeriod.start}
                    onChange={(e) => setMpDate(e.target.value)}
                    style={{ width: 150 }}
                    title="Pick any date — it snaps to that date's semi-monthly pay period."
                    disabled={pending}
                  />
                </label>
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>
                  Entry
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as 'total' | 'daily')}
                    disabled={pending}
                  >
                    <option value="total">Period total</option>
                    <option value="daily">Day-by-day</option>
                  </select>
                </label>
              </div>

              {mode === 'total' ? (
                <div>
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>
                    Total hours for period
                    <input
                      type="number"
                      step="0.01"
                      style={{ width: 120 }}
                      placeholder="e.g. 80"
                      value={totalStr}
                      onChange={(e) => setTotalStr(e.target.value)}
                      disabled={pending}
                    />
                  </label>
                </div>
              ) : (
                <div
                  className="table-scroll"
                  style={{ maxHeight: 200, overflow: 'auto', flex: '1 1 320px' }}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Hours</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dates.map((dt) => (
                        <tr key={dt}>
                          <td>{dt}</td>
                          <td>
                            <input
                              type="number"
                              step="0.01"
                              style={{ width: 90 }}
                              value={dailyMap[dt] ?? ''}
                              onChange={(e) =>
                                setDailyMap((prev) => ({ ...prev, [dt]: e.target.value }))
                              }
                              disabled={pending}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: 11 }}>
                  → {effPeriod.start} – {effPeriod.end}
                </span>
                <button type="button" className="btn sm" disabled={pending} onClick={handleSubmit}>
                  {pending ? 'Adding…' : 'Add → pending'}
                </button>
                <button type="button" className="btn ghost sm" disabled={pending} onClick={reset}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </td>
    </tr>
  );
};
