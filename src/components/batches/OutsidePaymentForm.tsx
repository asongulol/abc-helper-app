'use client';

/**
 * Record an OUTSIDE payment — a remittance made without the app (BPI/GCash by
 * hand, or a Wise transfer sent from the Wise site). Creates the payment row
 * as a record of money that already moved; a Wise row then shows up unlinked
 * in the period view above, where Match / manual link ties it to the real
 * transfer before reconciling.
 *
 * Designations split the amount by what it paid for (Backpay / 13th Month /
 * Health Allowance / PTO / Lunch / Other), each with its own amount and an
 * admin-side note; whatever is left undesignated stays as base pay. The
 * amount field remains the TOTAL remitted — it is what Wise matching keys on.
 */

import { useId, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { periodFor } from '@/lib/dates/periods';
import { addOutsidePayment } from '@/server/actions/payroll';
import { OUTSIDE_DESIGNATION_LABELS, type OutsideDesignationKind } from '@/types/schemas/payroll';

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
const KINDS = Object.keys(OUTSIDE_DESIGNATION_LABELS) as OutsideDesignationKind[];

interface DesignationLine {
  /** Stable render key — lines can be removed from the middle. */
  uid: number;
  kind: OutsideDesignationKind;
  label: string;
  amount: string;
  note: string;
}
let nextUid = 0;

const php = (n: number) => `₱${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

export const OutsidePaymentForm = ({ companyId, roster, onSaved }: OutsidePaymentFormProps) => {
  const id = useId();
  const { notify } = useToast();

  const [workerId, setWorkerId] = useState('');
  const [periodDate, setPeriodDate] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<(typeof METHODS)[number]>('wise');
  const [transferRef, setTransferRef] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<DesignationLine[]>([]);
  const [busy, setBusy] = useState(false);

  const period = /^\d{4}-\d{2}-\d{2}$/.test(periodDate) ? periodFor(periodDate) : null;
  const total = Number(amount) || 0;
  const designated = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const remainder = Math.round((total - designated) * 100) / 100;

  const pickWorker = (wid: string) => {
    setWorkerId(wid);
    const m = roster.find((r) => r.workerId === wid)?.payoutMethod;
    if (m && (METHODS as readonly string[]).includes(m)) setMethod(m as (typeof METHODS)[number]);
  };

  const setLine = (uid: number, patch: Partial<DesignationLine>) =>
    setLines((ls) => ls.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));

  const submit = async () => {
    if (!workerId || !period || !paidOn || !amount) {
      notify('Pick a contractor, the period, the paid date and the amount.', { type: 'error' });
      return;
    }
    for (const l of lines) {
      if (!(Number(l.amount) > 0)) {
        notify('Every designation needs an amount (or remove the empty line).', { type: 'error' });
        return;
      }
      if (l.kind === 'other' && !l.label.trim()) {
        notify("Name the 'Other' designation.", { type: 'error' });
        return;
      }
    }
    if (remainder < 0) {
      notify('Designated amounts exceed the payment amount.', { type: 'error' });
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
        transferRef: transferRef.trim() || undefined,
        designations: lines.map((l) => ({
          kind: l.kind,
          label: l.label.trim() || undefined,
          amountPhp: Number(l.amount),
          note: l.note.trim() || undefined,
        })),
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
      setTransferRef('');
      setReference('');
      setLines([]);
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
        can then be matched to the real transfer above. A period can be paid in several separate
        remittances — when the contractor already has a paid row on it, the extra one is recorded on
        its own batch dated the paid day (an <b>unpaid</b> row instead wants <b>Mark paid</b> in
        Process &amp; Pay — that money is the run’s, not a second payment).
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
        <div className="field">
          <label htmlFor={`${id}-tref`}>Transfer reference #</label>
          <input
            id={`${id}-tref`}
            type="text"
            placeholder="e.g. Wise #987654321 / BPI 000123"
            value={transferRef}
            onChange={(e) => setTransferRef(e.target.value)}
          />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 160 }}>
          <label htmlFor={`${id}-ref`}>Notes (optional)</label>
          <input
            id={`${id}-ref`}
            type="text"
            placeholder="anything worth remembering about this payment"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
        <button type="button" className="btn" disabled={busy} onClick={submit}>
          {busy ? 'Recording…' : 'Record payment'}
        </button>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 13 }}>What was it for?</b>
          <span className="muted" style={{ fontSize: 12 }}>
            optional — anything undesignated stays base pay
          </span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() =>
              setLines((ls) => [
                ...ls,
                { uid: ++nextUid, kind: 'backpay', label: '', amount: '', note: '' },
              ])
            }
          >
            + Add designation
          </button>
        </div>

        {lines.map((l) => (
          <div
            key={l.uid}
            className="row"
            style={{ alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 6 }}
          >
            <div className="field">
              <label htmlFor={`${id}-k${l.uid}`}>Designation</label>
              <select
                id={`${id}-k${l.uid}`}
                value={l.kind}
                onChange={(e) => setLine(l.uid, { kind: e.target.value as OutsideDesignationKind })}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {OUTSIDE_DESIGNATION_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            {l.kind === 'other' && (
              <div className="field">
                <label htmlFor={`${id}-l${l.uid}`}>Name it</label>
                <input
                  id={`${id}-l${l.uid}`}
                  type="text"
                  placeholder="e.g. Equipment"
                  value={l.label}
                  onChange={(e) => setLine(l.uid, { label: e.target.value })}
                />
              </div>
            )}
            <div className="field">
              <label htmlFor={`${id}-a${l.uid}`}>Amount (PHP)</label>
              <input
                id={`${id}-a${l.uid}`}
                type="number"
                min="0.01"
                step="0.01"
                value={l.amount}
                onChange={(e) => setLine(l.uid, { amount: e.target.value })}
              />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 160 }}>
              <label htmlFor={`${id}-n${l.uid}`}>Note (optional)</label>
              <input
                id={`${id}-n${l.uid}`}
                type="text"
                placeholder="admin-side, not shown to the contractor"
                value={l.note}
                onChange={(e) => setLine(l.uid, { note: e.target.value })}
              />
            </div>
            <button
              type="button"
              className="btn ghost sm"
              aria-label="Remove designation"
              onClick={() => setLines((ls) => ls.filter((x) => x.uid !== l.uid))}
            >
              ✕
            </button>
          </div>
        ))}

        {lines.length > 0 && (
          <p
            className="muted"
            style={{ fontSize: 12, marginTop: 6, color: remainder < 0 ? '#b91c1c' : undefined }}
          >
            {remainder < 0
              ? `Designated ${php(designated)} — that is ${php(-remainder)} more than the payment.`
              : `Designated ${php(designated)} of ${php(total)} — ${php(remainder)} stays base pay.`}
          </p>
        )}
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
