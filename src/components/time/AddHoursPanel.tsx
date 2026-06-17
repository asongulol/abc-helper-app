'use client';

/**
 * Inline "Add hours" panel — renders for a specific contractor already in the
 * period table. Two modes: period total (first-day only) or day-by-day.
 * Faithful to the legacy per-row addHoursForContractor logic.
 */

import { useState, useTransition } from 'react';
import { useToast } from '@/components/ui';
import { periodDates } from '@/lib/dates/periods';
import { addHoursDaily, addHoursTotal } from '@/server/actions/time';

interface AddHoursPanelProps {
  companyId: string;
  workerId: string | null;
  sourceName: string;
  periodStart: string;
  periodEnd: string;
  onDone: () => void;
  onCancel: () => void;
}

export const AddHoursPanel = ({
  companyId,
  workerId,
  sourceName,
  periodStart,
  periodEnd,
  onDone,
  onCancel,
}: AddHoursPanelProps) => {
  const { notify } = useToast();
  const [mode, setMode] = useState<'total' | 'daily'>('total');
  const [totalStr, setTotalStr] = useState('');
  const [dailyMap, setDailyMap] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const dates = periodDates(periodStart, periodEnd);

  const handleSubmit = () => {
    startTransition(async () => {
      if (mode === 'total') {
        const h = Number.parseFloat(totalStr);
        if (Number.isNaN(h) || h <= 0) {
          notify('Enter a positive number of hours.', { type: 'warn' });
          return;
        }
        const res = await addHoursTotal({
          companyId,
          workerId,
          sourceName,
          periodStart,
          hours: h,
        });
        if (!res.ok) {
          notify(res.error, { type: 'error' });
          return;
        }
      } else {
        const days = dates
          .map((date) => ({
            date,
            hours: Number.parseFloat(dailyMap[date] ?? '') || 0,
          }))
          .filter((d) => d.hours > 0);
        if (days.length === 0) {
          notify('Enter hours for at least one day.', { type: 'warn' });
          return;
        }
        const res = await addHoursDaily({
          companyId,
          workerId,
          sourceName,
          days,
        });
        if (!res.ok) {
          notify(res.error, { type: 'error' });
          return;
        }
      }
      notify(`Hours added for ${sourceName}.`, { type: 'success' });
      onDone();
    });
  };

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'flex-end',
        padding: '10px 0',
      }}
    >
      <div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
          Add hours for <b>{sourceName}</b> · {periodStart} – {periodEnd}
        </div>
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
                      placeholder="0"
                      value={dailyMap[dt] ?? ''}
                      onChange={(e) =>
                        setDailyMap((prev) => ({
                          ...prev,
                          [dt]: e.target.value,
                        }))
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

      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn sm" disabled={pending} onClick={handleSubmit}>
          {pending ? 'Adding…' : 'Add → pending'}
        </button>
        <button type="button" className="btn ghost sm" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </div>
  );
};
