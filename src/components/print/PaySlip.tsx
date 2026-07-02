/**
 * Pay-slip presentational component — server-safe (no 'use client', no DOM).
 * Behaviour per WORKFLOWS.md §10.1: render the gross / health allowance /
 * 13th-month / PDD-lunch / bonus / real misc lines and the NET taken verbatim
 * from the stored snapshot (never recomputed). The performance shortfall is
 * shown in a visually-separated MUTED box that explicitly states it is
 * informational and NOT deducted from pay. The footer shows the Wise transfer
 * id, the fx rate (labelled "market reference rate"), and the paid-at date.
 *
 * Styled with inline styles (matching the invoicing print page) so it renders
 * cleanly in a print window without any client CSS.
 */

import type { PaymentDetail } from '@/db/queries/payroll';
import { fmtDate, money } from '@/lib/format';

const cell = {
  borderBottom: '1px solid #ddd',
  padding: '6px 8px',
  textAlign: 'left',
} as const;
const cellRight = { ...cell, textAlign: 'right' } as const;

export function PaySlip({ pay }: { pay: PaymentDetail }) {
  // Real, taken-from-pay misc lines. `deduction` subtracts; others add. These
  // are part of the stored net snapshot — listed here for transparency.
  const earnLines = pay.miscItems.filter((m) => m.kind !== 'deduction' && Number(m.amount) > 0);
  const deductionLines = pay.miscItems.filter(
    (m) => m.kind === 'deduction' && Number(m.amount) > 0,
  );

  const labelFor = (kind: string, label?: string) =>
    label?.trim() ||
    (kind === 'other_earns'
      ? 'Other earnings'
      : kind === 'other_hours'
        ? 'Other hours'
        : kind === 'deduction'
          ? 'Deduction'
          : kind);

  return (
    <div
      style={{
        maxWidth: 680,
        margin: '24px auto',
        padding: '0 24px',
        color: '#15233b',
      }}
    >
      <h1 style={{ color: '#1F3A68', marginBottom: 4 }}>PAY SLIP</h1>
      <div>
        <strong>Contractor:</strong> {pay.name || '—'}
      </div>
      {pay.companyName && (
        <div>
          <strong>Company:</strong> {pay.companyName}
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        <strong>Period:</strong> {fmtDate(pay.periodStart)} → {fmtDate(pay.periodEnd)} &nbsp;{' '}
        <strong>Pay date:</strong> {fmtDate(pay.payDate)} &nbsp; <strong>Status:</strong>{' '}
        {pay.status}
      </div>

      <table
        aria-label="Pay statement"
        style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}
      >
        <thead>
          <tr>
            <th scope="col" style={cell}>
              Item
            </th>
            <th scope="col" style={cellRight}>
              Amount (PHP)
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={cell}>Gross</td>
            <td style={cellRight}>{money(pay.grossPhp)}</td>
          </tr>
          {pay.haPhp > 0 && (
            <tr>
              <td style={cell}>Health allowance</td>
              <td style={cellRight}>{money(pay.haPhp)}</td>
            </tr>
          )}
          {pay.t13Php > 0 && (
            <tr>
              <td style={cell}>13th-month accrual</td>
              <td style={cellRight}>{money(pay.t13Php)}</td>
            </tr>
          )}
          {pay.pddPhp > 0 && (
            <tr>
              <td style={cell}>PDD / lunch</td>
              <td style={cellRight}>{money(pay.pddPhp)}</td>
            </tr>
          )}
          {pay.bonusPhp > 0 && (
            <tr>
              <td style={cell}>Bonus</td>
              <td style={cellRight}>{money(pay.bonusPhp)}</td>
            </tr>
          )}
          {pay.offCyclePhp > 0 && (
            <tr>
              <td style={cell}>Off-cycle pay</td>
              <td style={cellRight}>{money(pay.offCyclePhp)}</td>
            </tr>
          )}
          {earnLines.map((m) => (
            <tr key={`earn-${m.kind}-${m.label ?? ''}-${m.amount ?? ''}`}>
              <td style={cell}>{labelFor(m.kind, m.label)}</td>
              <td style={cellRight}>{money(Number(m.amount) || 0)}</td>
            </tr>
          ))}
          {deductionLines.map((m) => (
            <tr key={`ded-${m.kind}-${m.label ?? ''}-${m.amount ?? ''}`}>
              <td style={cell}>{labelFor(m.kind, m.label)}</td>
              <td style={{ ...cellRight, color: '#991b1b' }}>−{money(Number(m.amount) || 0)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td
              style={{
                ...cell,
                fontWeight: 700,
                borderTop: '2px solid #1F3A68',
              }}
            >
              Net pay
            </td>
            <td
              style={{
                ...cellRight,
                fontWeight: 700,
                borderTop: '2px solid #1F3A68',
              }}
            >
              {money(pay.netPhp)}
            </td>
          </tr>
        </tfoot>
      </table>

      {pay.shortfallPhp > 0 && (
        <div
          style={{
            marginTop: 16,
            padding: '10px 12px',
            background: '#f3f4f6',
            border: '1px solid #d1d5db',
            borderRadius: 8,
            color: '#677083',
            fontSize: 12,
          }}
        >
          <strong style={{ color: '#677083' }}>Performance shortfall — informational</strong>
          <div style={{ marginTop: 2 }}>
            {money(pay.shortfallPhp)} — this reflects hours below the expected target and is{' '}
            <strong>not deducted from your pay</strong>. Your net above is unaffected.
          </div>
        </div>
      )}

      <div style={{ marginTop: 24, color: '#677083', fontSize: 11 }}>
        <div>
          <strong>Paid via:</strong> {pay.payoutMethod ?? '—'}
          {pay.payoutAmount != null && pay.payoutCurrency
            ? ` · ${money(pay.payoutAmount, pay.payoutCurrency === 'USD' ? 'USD' : 'PHP')} (${pay.payoutCurrency})`
            : ''}
        </div>
        {pay.fxRate != null && (
          <div>
            <strong>FX rate:</strong> {pay.fxRate} (market reference rate)
          </div>
        )}
        {pay.wiseTransferId && (
          <div>
            <strong>Wise transfer:</strong> {pay.wiseTransferId}
          </div>
        )}
        <div>
          <strong>Paid at:</strong> {fmtDate(pay.paidAt)}
        </div>
      </div>
    </div>
  );
}
