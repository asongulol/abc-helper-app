'use client';

import { useEffect, useState, useTransition } from 'react';
import { Spinner } from '@/components/ui';
import type { RateHistoryRow } from '@/db/queries/rates';
import { fmtDate, money } from '@/lib/format';
import { getRateHistory, saveRate } from '@/server/actions/payroll';

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
        <div className="table-scroll" style={{ marginBottom: 20 }}>
          <table aria-label="Rate history">
            <thead>
              <tr>
                <th scope="col">Amount (PHP/period)</th>
                <th scope="col">Effective start</th>
                <th scope="col">Effective end</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  <td>{money(r.amountPhp)}</td>
                  <td>{fmtDate(r.effectiveStart)}</td>
                  <td>
                    {r.effectiveEnd ? (
                      fmtDate(r.effectiveEnd)
                    ) : (
                      <span className="pill good">open</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
