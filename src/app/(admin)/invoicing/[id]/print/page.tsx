import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { AutoPrint } from '@/components/invoicing/AutoPrint';
import { createServerSupabase } from '@/db/clients/server';
import { fetchEmployerCompany, fetchInvoiceDetail } from '@/db/queries/invoicing';
import { fmtDate, money } from '@/lib/format';
import { getCurrentAdmin } from '@/server/auth/admin';

export const metadata: Metadata = {
  title: 'Invoice — Aaron Anderson E.H.S. LLC',
};

const cell = {
  borderBottom: '1px solid #ddd',
  padding: '6px 8px',
  textAlign: 'left',
} as const;
const cellRight = { ...cell, textAlign: 'right' } as const;

export default async function InvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const { id } = await params;
  const supabase = await createServerSupabase();
  const [invoice, employer] = await Promise.all([
    fetchInvoiceDetail(supabase, id),
    fetchEmployerCompany(supabase),
  ]);
  if (!invoice) notFound();

  const markupAmount = invoice.totalUsd - invoice.subtotalUsd;

  return (
    <div
      style={{
        maxWidth: 760,
        margin: '24px auto',
        padding: '0 24px',
        color: '#15233b',
      }}
    >
      <AutoPrint />

      <h1 style={{ color: '#1F3A68', marginBottom: 4 }}>INVOICE</h1>
      <div>
        <strong>From:</strong> {employer?.name ?? 'Employer'}
      </div>
      <div>
        <strong>Bill to:</strong> {invoice.companyName}
      </div>
      <div style={{ marginTop: 6 }}>
        <strong>Invoice #:</strong> {invoice.invoiceNo ?? '—'} &nbsp; <strong>Period:</strong>{' '}
        {fmtDate(invoice.periodStart)} → {fmtDate(invoice.periodEnd)} &nbsp;{' '}
        <strong>Status:</strong> {invoice.status}
      </div>

      <table
        style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}
        aria-label="Invoice lines"
      >
        <thead>
          <tr>
            <th scope="col" style={cell}>
              Contractor
            </th>
            <th scope="col" style={cell}>
              Position
            </th>
            <th scope="col" style={cell}>
              Type
            </th>
            <th scope="col" style={cellRight}>
              Qty
            </th>
            <th scope="col" style={cellRight}>
              Unit rate
            </th>
            <th scope="col" style={cellRight}>
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => (
            <tr key={`${l.workerName ?? 'line'}-${l.kind}-${l.position ?? ''}-${l.amountUsd}`}>
              <td style={cell}>{l.workerName ?? '—'}</td>
              <td style={cell}>{l.position ?? '—'}</td>
              <td style={cell}>{l.kind === 'session' ? 'Sessions' : 'Hours'}</td>
              <td style={cellRight}>
                {l.kind === 'session' ? (l.sessionsCount ?? 0) : l.workedHours.toFixed(2)}
              </td>
              <td style={cellRight}>
                {l.kind === 'session'
                  ? `${money(l.sessionRateUsd ?? 0, 'USD')}/visit`
                  : `${money(l.billRateUsd, 'USD')}/hr`}
              </td>
              <td style={cellRight}>{money(l.amountUsd, 'USD')}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {invoice.markupPct > 0 && (
            <>
              <tr>
                <td colSpan={5} style={cellRight}>
                  Subtotal
                </td>
                <td style={cellRight}>{money(invoice.subtotalUsd, 'USD')}</td>
              </tr>
              <tr>
                <td colSpan={5} style={cellRight}>
                  Markup {invoice.markupPct}%
                </td>
                <td style={cellRight}>{money(markupAmount, 'USD')}</td>
              </tr>
            </>
          )}
          <tr>
            <td
              colSpan={5}
              style={{
                ...cellRight,
                fontWeight: 700,
                borderTop: '2px solid #1F3A68',
              }}
            >
              Total (USD)
            </td>
            <td
              style={{
                ...cellRight,
                fontWeight: 700,
                borderTop: '2px solid #1F3A68',
              }}
            >
              {money(invoice.totalUsd, 'USD')}
            </td>
          </tr>
        </tfoot>
      </table>

      <p style={{ marginTop: 24, color: '#677083', fontSize: 11 }}>
        Billed for worked hours and per-session services; paid time off is not billed.
      </p>
    </div>
  );
}
