'use client';

import { useEffect, useState, useTransition } from 'react';
import { Spinner } from '@/components/ui';
import type { RateHistoryRow } from '@/db/queries/rates';
import { fmtDate, money } from '@/lib/format';
import {
  deleteRate,
  editRateEffectiveDate,
  getRateHistory,
  saveRate,
} from '@/server/actions/payroll';

type Props = {
  workerId: string;
  companyId: string;
};

export function RateCard({ workerId, companyId }: Props) {
  const [history, setHistory] = useState<RateHistoryRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [effectiveStart, setEffectiveStart] = useState('');
  const [formError, setFormError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');
  const [isLoadPending, startLoad] = useTransition();
  const [isSavePending, startSave] = useTransition();
  // Inline rate-row editing (effective-from date) + two-click delete confirm.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState('');
  const [isRowPending, startRow] = useTransition();

  useEffect(() => {
    startLoad(async () => {
      const result = await getRateHistory({ workerId, companyId });
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      setHistory(result.data?.history ?? []);
    });
    // startLoad is stable (from useTransition); workerId/companyId drive the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId, companyId]);

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const amountPhp = Number.parseFloat(amountStr);
    if (!amountStr || Number.isNaN(amountPhp) || amountPhp <= 0) {
      setFormError('Enter a positive amount.');
      return;
    }
    if (!effectiveStart || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveStart)) {
      setFormError('Enter a valid effective date (YYYY-MM-DD).');
      return;
    }
    setFormError('');
    setSaveSuccess('');

    startSave(async () => {
      const result = await saveRate({
        workerId,
        companyId,
        amountPhp,
        effectiveStart,
      });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      const kind = result.data?.kind;
      setSaveSuccess(
        kind === 'same-day-update'
          ? 'Same-day rate updated in place.'
          : 'Rate saved — prior open rate closed.',
      );
      setAmountStr('');
      setEffectiveStart('');
      // Reload history.
      startLoad(async () => {
        const r2 = await getRateHistory({ workerId, companyId });
        if (r2.ok) setHistory(r2.data?.history ?? []);
      });
    });
  }

  const today = new Date().toISOString().slice(0, 10);

  function reloadHistory() {
    startLoad(async () => {
      const r2 = await getRateHistory({ workerId, companyId });
      if (r2.ok) setHistory(r2.data?.history ?? []);
    });
  }

  function startEdit(r: RateHistoryRow) {
    setEditingId(r.id);
    setEditDate(r.effectiveStart);
    setConfirmDeleteId(null);
    setRowMsg('');
  }

  function saveEdit(r: RateHistoryRow) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(editDate)) {
      setRowMsg('Pick a valid date.');
      return;
    }
    if (editDate === r.effectiveStart) {
      setEditingId(null);
      return;
    }
    setRowMsg('');
    startRow(async () => {
      const res = await editRateEffectiveDate({
        workerId,
        companyId,
        rateId: r.id,
        effectiveStart: editDate,
      });
      if (!res.ok) {
        setRowMsg(res.error);
        return;
      }
      setEditingId(null);
      setEditDate('');
      setRowMsg(`Rate effective date updated to ${editDate}.`);
      reloadHistory();
    });
  }

  function removeRow(r: RateHistoryRow) {
    setRowMsg('');
    startRow(async () => {
      const res = await deleteRate({ workerId, companyId, rateId: r.id });
      if (!res.ok) {
        setRowMsg(res.error);
        return;
      }
      setConfirmDeleteId(null);
      setRowMsg(`Deleted rate ${money(r.amountPhp)} from ${fmtDate(r.effectiveStart)}.`);
      reloadHistory();
    });
  }

  function rowActions(r: RateHistoryRow) {
    if (editingId === r.id) {
      return (
        <>
          <button
            type="button"
            className="btn ghost sm"
            disabled={isRowPending}
            onClick={() => saveEdit(r)}
          >
            Save
          </button>{' '}
          <button
            type="button"
            className="btn ghost sm"
            disabled={isRowPending}
            onClick={() => {
              setEditingId(null);
              setRowMsg('');
            }}
          >
            Cancel
          </button>
        </>
      );
    }
    if (confirmDeleteId === r.id) {
      return (
        <>
          <span className="muted" style={{ fontSize: 12, marginRight: 6 }}>
            Delete this rate row?
          </span>
          <button
            type="button"
            className="btn sm"
            style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }}
            disabled={isRowPending}
            onClick={() => removeRow(r)}
          >
            Confirm
          </button>{' '}
          <button
            type="button"
            className="btn ghost sm"
            disabled={isRowPending}
            onClick={() => setConfirmDeleteId(null)}
          >
            Cancel
          </button>
        </>
      );
    }
    return (
      <>
        <button
          type="button"
          className="btn ghost sm"
          title="Edit the effective-from date for this rate row"
          disabled={isRowPending}
          onClick={() => startEdit(r)}
        >
          Edit date
        </button>{' '}
        <button
          type="button"
          className="btn ghost sm"
          style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
          title="Remove this rate row from history. The previous rate's effective_end will extend to cover the gap."
          disabled={isRowPending}
          onClick={() => {
            setConfirmDeleteId(r.id);
            setRowMsg('');
          }}
        >
          Delete
        </button>
      </>
    );
  }

  return (
    <div>
      <h4
        style={{
          margin: '0 0 12px',
          fontSize: 13,
          textTransform: 'uppercase',
          letterSpacing: '.05em',
          color: 'var(--muted)',
        }}
      >
        Rate history
      </h4>

      {isLoadPending && <Spinner />}
      {loadError && (
        <div className="field-err" style={{ marginBottom: 8 }}>
          {loadError}
        </div>
      )}

      {history != null && history.length === 0 && (
        <p className="muted" style={{ marginBottom: 12 }}>
          No rate history yet.
        </p>
      )}

      {history != null && history.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Amount (PHP/period)</th>
                  <th>Effective start</th>
                  <th>Effective end</th>
                  <th style={{ textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td>{money(r.amountPhp)}</td>
                    <td>
                      {editingId === r.id ? (
                        <input
                          type="date"
                          value={editDate}
                          max={today}
                          disabled={isRowPending}
                          onChange={(e) => setEditDate(e.target.value)}
                          style={{ fontSize: 13, padding: '2px 4px' }}
                        />
                      ) : (
                        fmtDate(r.effectiveStart)
                      )}
                    </td>
                    <td>
                      {r.effectiveEnd ? (
                        fmtDate(r.effectiveEnd)
                      ) : (
                        <span className="pill good">open</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{rowActions(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Editing or deleting a rate row recomputes neighbouring effective_end dates so the
            timeline stays contiguous. These changes are recorded in the audit log.
          </p>
          {rowMsg && (
            <div className="field-err" style={{ marginTop: 4 }}>
              {rowMsg}
            </div>
          )}
        </div>
      )}

      <h4
        style={{
          margin: '0 0 12px',
          fontSize: 13,
          textTransform: 'uppercase',
          letterSpacing: '.05em',
          color: 'var(--muted)',
        }}
      >
        Set new rate
      </h4>
      <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        Semi-monthly PHP amount. Same-day saves replace the existing row instead of stacking.
      </p>
      <form onSubmit={handleSave}>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="rc-amount">Amount (PHP)</label>
            <input
              id="rc-amount"
              type="number"
              min="0.01"
              step="0.01"
              placeholder="e.g. 12000.00"
              value={amountStr}
              onChange={(e) => {
                setAmountStr(e.target.value);
                setFormError('');
                setSaveSuccess('');
              }}
              disabled={isSavePending}
              aria-invalid={formError && !amountStr ? 'true' : undefined}
            />
          </div>
          <div className="field">
            <label htmlFor="rc-eff">Effective date</label>
            <input
              id="rc-eff"
              type="date"
              value={effectiveStart}
              max={today}
              onChange={(e) => {
                setEffectiveStart(e.target.value);
                setFormError('');
                setSaveSuccess('');
              }}
              disabled={isSavePending}
              aria-invalid={formError && !effectiveStart ? 'true' : undefined}
            />
          </div>
        </div>
        {formError && (
          <div className="field-err" style={{ marginBottom: 8 }}>
            {formError}
          </div>
        )}
        {saveSuccess && (
          <div
            className="banner"
            style={{
              marginBottom: 8,
              borderColor: 'var(--good)',
              background: 'var(--good-soft)',
              color: 'var(--good)',
            }}
          >
            {saveSuccess}
          </div>
        )}
        <button type="submit" className="btn" disabled={isSavePending}>
          {isSavePending ? (
            <>
              <Spinner /> Saving…
            </>
          ) : (
            'Save rate'
          )}
        </button>
      </form>
    </div>
  );
}
