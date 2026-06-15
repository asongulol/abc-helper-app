'use client';

/**
 * Delete imports — date-range delete (with dry-run preview + locked/paid overlap
 * confirmation) and the per-batch delete list. Port of the legacy DeleteImports
 * component (app/index.html). Copy/labels are verbatim from the legacy app.
 */

import { useToast } from '@/components/ui';
import type { ImportBatchGroup, RangeDryRun } from '@/server/actions/import';
import { deleteImportRange, dryRunDeleteRange } from '@/server/actions/import';
import { deleteImportBatch } from '@/server/actions/time';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

interface DeleteImportsClientProps {
  companyId: string;
  batches: ImportBatchGroup[];
}

interface ArmedRange {
  type: 'range';
  count: number;
  start: string;
  stop: string;
  overlap: RangeDryRun['overlap'];
  preview: RangeDryRun['preview'];
}

const labelStyle = {
  fontSize: 11,
  color: 'var(--muted)',
  textTransform: 'uppercase' as const,
  letterSpacing: '.03em',
};

export const DeleteImportsClient = ({ companyId, batches }: DeleteImportsClientProps) => {
  const router = useRouter();
  const { notify } = useToast();
  const [pending, startTransition] = useTransition();

  const [delStart, setDelStart] = useState('');
  const [delStop, setDelStop] = useState('');
  const [armed, setArmed] = useState<ArmedRange | null>(null);
  const [confirmText, setConfirmText] = useState('');
  // per-batch armed index for the 2nd-click confirm.
  const [armedBatch, setArmedBatch] = useState<number | null>(null);

  function armRange() {
    if (!delStart || !delStop) {
      notify('Enter both start and stop dates.', { type: 'error' });
      return;
    }
    if (delStart > delStop) {
      notify("'From' must be on or before 'To'.", { type: 'error' });
      return;
    }
    startTransition(async () => {
      const res = await dryRunDeleteRange({ companyId, start: delStart, stop: delStop });
      if (!res.ok) {
        notify(res.error, { type: 'error', persistent: true });
        return;
      }
      if (res.data.count === 0) {
        notify('No time entries in that range.', { type: 'info' });
        return;
      }
      setConfirmText('');
      setArmed({
        type: 'range',
        count: res.data.count,
        start: delStart,
        stop: delStop,
        overlap: res.data.overlap,
        preview: res.data.preview,
      });
    });
  }

  function doDeleteRange() {
    startTransition(async () => {
      const res = await deleteImportRange({
        companyId,
        start: delStart,
        stop: delStop,
        ...(confirmText ? { confirmText } : {}),
      });
      setArmed(null);
      setConfirmText('');
      if (!res.ok) {
        notify(res.error, { type: 'error', persistent: true });
        return;
      }
      const cleared = res.data.clearedBatches
        ? ` and ${res.data.clearedBatches} draft pay batch(es)`
        : '';
      notify(`Deleted ${res.data.deleted} time entries in ${delStart} → ${delStop}${cleared}.`, {
        type: 'success',
      });
      router.refresh();
    });
  }

  function doDeleteBatch(b: ImportBatchGroup) {
    setArmedBatch(null);
    if (!b.id) {
      notify(
        'This group has no batch ID stored (legacy or manual data). Use the date-range delete above, covering the dates shown for this batch.',
        { type: 'info' },
      );
      return;
    }
    startTransition(async () => {
      const res = await deleteImportBatch({ companyId, batchId: b.id });
      if (!res.ok) {
        notify(res.error, { type: 'error', persistent: true });
        return;
      }
      notify(`Deleted import (${b.rows} rows).`, { type: 'success' });
      router.refresh();
    });
  }

  return (
    <div className="card">
      <h2>Delete imports</h2>
      <p className="sub">
        Remove time you imported in error or want to re-pull. Click Delete, then Confirm. (Tip:
        re-importing the same period overwrites rather than duplicates, so you usually only need
        this to clear bad data.)
      </p>

      <div style={{ marginBottom: 14 }}>
        <span style={labelStyle}>By date range</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 6 }}>
          <div>
            <label htmlFor="del-from" style={{ fontSize: 10, color: 'var(--muted)' }}>
              From
            </label>
            <br />
            <input
              id="del-from"
              type="date"
              value={delStart}
              onChange={(e) => {
                setDelStart(e.target.value);
                setArmed(null);
              }}
            />
          </div>
          <div>
            <label htmlFor="del-to" style={{ fontSize: 10, color: 'var(--muted)' }}>
              To
            </label>
            <br />
            <input
              id="del-to"
              type="date"
              value={delStop}
              onChange={(e) => {
                setDelStop(e.target.value);
                setArmed(null);
              }}
            />
          </div>
          {armed && armed.type === 'range' ? (
            armed.overlap.length > 0 ? (
              <span
                style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
              >
                <span style={{ fontSize: 12, color: 'var(--bad)', fontWeight: 600 }}>
                  Delete {armed.count} rows · {armed.start} → {armed.stop}
                </span>
                <span style={{ fontSize: 11, color: 'var(--bad)' }}>
                  ⚠️ overlaps {armed.overlap.length} locked/paid period(s) · type DELETE to confirm
                </span>
                <input
                  type="text"
                  placeholder="type DELETE"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  style={{ fontSize: 12, padding: '2px 6px', width: 110 }}
                />
                <button
                  type="button"
                  className="btn sm"
                  style={{ background: 'var(--bad)' }}
                  disabled={pending || confirmText !== 'DELETE'}
                  onClick={doDeleteRange}
                >
                  Confirm
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    setArmed(null);
                    setConfirmText('');
                  }}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--bad)' }}>
                  Delete {armed.count} rows · {armed.start} → {armed.stop}?
                </span>
                <button
                  type="button"
                  className="btn sm"
                  style={{ background: 'var(--bad)' }}
                  disabled={pending}
                  onClick={doDeleteRange}
                >
                  Confirm
                </button>
                <button type="button" className="btn ghost sm" onClick={() => setArmed(null)}>
                  Cancel
                </button>
              </span>
            )
          ) : (
            <button
              type="button"
              className="btn ghost"
              style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
              disabled={pending}
              onClick={armRange}
            >
              Delete range
            </button>
          )}
        </div>

        {armed && armed.type === 'range' && armed.preview.length > 0 && (
          <div
            style={{
              marginTop: 8,
              padding: '8px 10px',
              background: '#f8fafc',
              border: '1px solid var(--border)',
              borderRadius: 4,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              Will delete {armed.count} row(s) across {armed.preview.length} contractor(s):
            </div>
            <div className="table-scroll" style={{ maxHeight: 180 }}>
              <table style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Contractor</th>
                    <th>Rows</th>
                    <th>Hours</th>
                    <th>Date span</th>
                  </tr>
                </thead>
                <tbody>
                  {armed.preview.slice(0, 30).map((g, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no stable id
                    <tr key={i}>
                      <td>{g.name}</td>
                      <td>{g.rows}</td>
                      <td>{g.hours.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td className="muted">
                        {g.firstDate === g.lastDate
                          ? g.firstDate
                          : `${g.firstDate} → ${g.lastDate}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {armed.preview.length > 30 && (
              <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>
                …and {armed.preview.length - 30} more contractor(s).
              </p>
            )}
          </div>
        )}

        {armed && armed.type === 'range' && armed.overlap.length > 0 && (
          <div
            style={{
              marginTop: 8,
              padding: '8px 10px',
              background: '#fef3c7',
              border: '1px solid #fcd34d',
              borderRadius: 4,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: '#92400e' }}>
              This range overlaps {armed.overlap.length}{' '}
              {armed.overlap.length === 1 ? 'period' : 'periods'} that{' '}
              {armed.overlap.length === 1 ? 'is' : 'are'} already locked/paid:
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#92400e' }}>
              {armed.overlap.slice(0, 10).map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: overlap periods have no stable id
                <li key={i}>
                  {p.periodStart} → {p.periodEnd} <b>· {p.state}</b>
                </li>
              ))}
              {armed.overlap.length > 10 && <li>…and {armed.overlap.length - 10} more</li>}
            </ul>
            <p style={{ margin: '6px 0 0', fontSize: 11, color: '#92400e' }}>
              Deleting time entries here won't unwind the payments themselves, but it will break
              re-calculation, audit reports, and any future re-locking of these periods. If these
              are real paid periods, <b>cancel</b> and narrow your range.
            </p>
          </div>
        )}
      </div>

      <span style={labelStyle}>By import batch (most recent)</span>
      {batches.length === 0 ? (
        <div className="empty" style={{ padding: 20 }}>
          No imports recorded.
        </div>
      ) : (
        <div className="table-scroll">
          <table style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>Imported</th>
                <th>Date range</th>
                <th>Rows</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {batches.map((b, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: batch groups have no stable id
                <tr key={i}>
                  <td className="card-title">{b.when ? new Date(b.when).toLocaleString() : '—'}</td>
                  <td data-label="Date range">
                    {b.min} → {b.max}
                  </td>
                  <td data-label="Rows">{b.rows}</td>
                  <td className="card-action" style={{ textAlign: 'right' }}>
                    {armedBatch === i ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <button
                          type="button"
                          className="btn sm"
                          style={{ background: 'var(--bad)' }}
                          disabled={pending}
                          onClick={() => doDeleteBatch(b)}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => setArmedBatch(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn ghost sm"
                        style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
                        disabled={pending}
                        onClick={() => setArmedBatch(i)}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
