'use client';

/**
 * Record an OUTSIDE payment — a remittance made without the app (BPI/GCash by
 * hand, or a Wise transfer sent from the Wise site). Creates the payment row
 * as a record of money that already moved; a Wise row then shows up unlinked
 * in the period view above, where Match / manual link ties it to the real
 * transfer before reconciling.
 */

import { useId, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { periodFor } from '@/lib/dates/periods';
import { addOutsidePayment } from '@/server/actions/payroll';

export interface OutsideRosterEntry {
  workerId: string;
  name: string;
  payoutMethod: string | null;
}

interface OutsidePaymentFormProps {
  companyId: string;
  roster: OutsideRosterEntry[];
  /** Called with the period id after a successful save (refresh + open it). */
  onSaved: (periodId: string) => void | Promise<void>;
}

const METHODS = ['wise', 'bpi', 'gcash', 'paymaya', 'paypal'] as const;

export const OutsidePaymentForm = ({ companyId, roster, onSaved }: OutsidePaymentFormProps) => {
  const id = useId();
  const { notify } = useToast();

  const [workerId, setWorkerId] = useState('');
  const [periodDate, setPeriodDate] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<(typeof METHODS)[number]>('wise');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);

  const period = /^\d{4}-\d{2}-\d{2}$/.test(periodDate) ? periodFor(periodDate) : null;

  const pickWorker = (wid: string) => {
    setWorkerId(wid);
    const m = roster.find((r) => r.workerId === wid)?.payoutMethod;
    if (m && (METHODS as readonly string[]).includes(m)) setMethod(m as (typeof METHODS)[number]);
  };

  const submit = async () => {
    if (!workerId || !period || !paidOn || !amount) {
      notify('Pick a contractor, the period, the paid date and the amount.', { type: 'error' });
      return;
    }
    setBusy(true);
    try {
      const res = await addOutsidePayment({
        companyId,
        periodStart: period.start,
        periodEnd: period.end,
        workerId,
        amountPhp: Number(amount),
        paidOn,
        payoutMethod: method,
        reference: reference.trim() || undefined,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(
        method === 'wise'
          ? 'Outside payment recorded — open the period and run Match missing transfers to link the Wise transfer.'
          : 'Outside payment recorded.',
        { type: 'success' },
      );
      setAmount('');
      setReference('');
      await onSaved(res.data.periodId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Record an outside payment</h2>
      <p className="sub">
        A remittance made <b>without the app</b> (bank transfer by hand, or a Wise transfer sent
        from the Wise site). Recorded as already paid on the period it covers; a <b>Wise</b> payment
        can then be matched to the real transfer above. If the contractor already has a row on the
        period, use <b>Mark paid</b> / Wise matching on that row instead.
      </p>

      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field">
          <label htmlFor={`${id}-worker`}>Contractor</label>
          <select id={`${id}-worker`} value={workerId} onChange={(e) => pickWorker(e.target.value)}>
            <option value="">Select…</option>
            {roster.map((r) => (
              <option key={r.workerId} value={r.workerId}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-period`}>Any day in the period covered</label>
          <input
            id={`${id}-period`}
            type="date"
            value={periodDate}
            onChange={(e) => setPeriodDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-paid`}>Paid on</label>
          <input
            id={`${id}-paid`}
            type="date"
            value={paidOn}
            onChange={(e) => setPaidOn(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-amount`}>Amount (PHP)</label>
          <input
            id={`${id}-amount`}
            type="number"
            min="0.01"
            step="0.01"
            placeholder="e.g. 12500"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-method`}>Method</label>
          <select
            id={`${id}-method`}
            value={method}
            onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 180 }}>
          <label htmlFor={`${id}-ref`}>Reference (optional)</label>
          <input
            id={`${id}-ref`}
            type="text"
            placeholder="e.g. BPI ref 000123 / Wise batch of Jul 30"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
        <button type="button" className="btn" disabled={busy} onClick={submit}>
          {busy ? 'Recording…' : 'Record payment'}
        </button>
      </div>

      {period && (
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Period: <b>{period.start}</b> → <b>{period.end}</b> (pay date {period.payDate}). A period
          that was never run in the app is created and closed with just this record.
        </p>
      )}
    </div>
  );
};
