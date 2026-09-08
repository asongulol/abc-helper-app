'use client';

/**
 * Inline "Days" panel — one contractor's entries for the period, day by day,
 * with tracked hours editable. This is the way back from a mistaken Add hours
 * (which sums into the day's row and cannot be undone): type the right number
 * for that day and save. Only changed days are sent.
 */

import { useState, useTransition } from 'react';
import { Badge, type BadgeTone, useToast } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import type { TimeEntryRaw } from '@/lib/time/grouping';
import { editContractorDays } from '@/server/actions/time';

interface Props {
  companyId: string;
  sourceName: string;
  entries: TimeEntryRaw[];
  periodStart: string;
  periodEnd: string;
  onDone: () => void;
  onCancel: () => void;
}

const toHours = (seconds: number) => (seconds / 3600).toFixed(2);
const TONE: Record<TimeEntryRaw['approval'], BadgeTone> = {
  approved: 'good',
  rejected: 'bad',
  pending: 'warn',
};

export const DayHoursPanel = ({
  companyId,
  sourceName,
  entries,
  periodStart,
  periodEnd,
  onDone,
  onCancel,
}: Props) => {
  const { notify } = useToast();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const days = [...entries].sort((a, b) => a.workDate.localeCompare(b.workDate));

  const hoursOf = (e: TimeEntryRaw): number => {
    const raw = edits[e.id];
    return raw === undefined ? e.trackedSeconds / 3600 : Number.parseFloat(raw);
  };
  const changed = days
    .filter((e) => edits[e.id] !== undefined && edits[e.id] !== toHours(e.trackedSeconds))
    .map((e) => ({ id: e.id, hours: hoursOf(e) }));
  const total = days.reduce((s, e) => s + (Number.isNaN(hoursOf(e)) ? 0 : hoursOf(e)), 0);

  const save = () => {
    if (changed.some((c) => Number.isNaN(c.hours) || c.hours < 0)) {
      notify('Enter a valid number of hours.', { type: 'warn' });
      return;
    }
    startTransition(async () => {
      const res = await editContractorDays({
        companyId,
        sourceName,
        days: changed,
        periodStart,
        periodEnd,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(`Updated ${changed.length} day${changed.length === 1 ? '' : 's'} for ${sourceName}.`, {
        type: 'success',
      });
      if (res.data.calcNote) notify(res.data.calcNote, { type: 'warn' });
      onDone();
    });
  };

  return (
    <div style={{ padding: '8px 4px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <b>{sourceName} — day by day</b>
        <span className="sub" style={{ fontSize: 12 }}>
          Tracked total {total.toFixed(2)}h · change a day's hours and save
        </span>
      </div>
      <div className="table-scroll" style={{ marginTop: 6 }}>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Status</th>
              <th>Tracked (h)</th>
              <th>PTO (h)</th>
            </tr>
          </thead>
          <tbody>
            {days.map((e) => (
              <tr key={e.id}>
                <td>{fmtDate(e.workDate)}</td>
                <td>
                  <Badge tone={TONE[e.approval]}>{e.approval}</Badge>
                </td>
                <td>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="24"
                    style={{ width: 90 }}
                    aria-label={`Tracked hours for ${sourceName} on ${e.workDate}`}
                    value={edits[e.id] ?? toHours(e.trackedSeconds)}
                    onChange={(ev) => setEdits((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                  />
                </td>
                <td>{toHours(e.ptoSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          className="btn sm"
          disabled={pending || changed.length === 0}
          onClick={save}
        >
          {pending
            ? 'Saving…'
            : changed.length
              ? `Save ${changed.length} change${changed.length === 1 ? '' : 's'}`
              : 'Save'}
        </button>
        <button type="button" className="btn ghost sm" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
};
