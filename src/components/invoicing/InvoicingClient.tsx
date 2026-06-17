'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { Badge, type BadgeTone, useToast } from '@/components/ui';
import type { ClientOption, InvoiceListRow } from '@/db/queries/invoicing';
import { fmtDate, money } from '@/lib/format';
import { downloadCsv } from '@/lib/reports/csv';
import {
  generateInvoice,
  type InvoicePreviewResult,
  previewInvoice,
  setInvoiceStatus,
} from '@/server/actions/invoicing';

interface Props {
  clients: ClientOption[];
  invoices: InvoiceListRow[];
  defaultFrom: string;
  defaultTo: string;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  draft: 'warn',
  sent: 'neutral',
  paid: 'good',
  void: 'bad',
};

const csvEscape = (v: string | number | null | undefined): string => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const labelStyle = { display: 'block', fontSize: 11 } as const;
const rightAlign = { textAlign: 'right' } as const;

export const InvoicingClient = ({ clients, invoices, defaultFrom, defaultTo }: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [clientId, setClientId] = useState('');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [markup, setMarkup] = useState('0');
  const [preview, setPreview] = useState<InvoicePreviewResult | null>(null);
  const [isPreviewing, startPreview] = useTransition();
  const [isGenerating, startGenerate] = useTransition();
  const [isUpdating, startUpdate] = useTransition();

  const clientName = clients.find((c) => c.id === clientId)?.name ?? '';
  const history = useMemo(
    () => (clientId ? invoices.filter((i) => i.companyId === clientId) : invoices),
    [invoices, clientId],
  );

  const handlePreview = () => {
    if (!clientId) {
      notify('Pick a client to invoice.', { type: 'warn' });
      return;
    }
    startPreview(async () => {
      const res = await previewInvoice({
        clientId,
        from,
        to,
        markupPct: Number(markup) || 0,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        setPreview(null);
        return;
      }
      setPreview(res.data);
      if (res.data.lines.length === 0) {
        notify('No worked hours for this client in the window.', {
          type: 'warn',
        });
      } else if (res.data.zeroRateNames.length > 0) {
        notify(`No USD bill rate for ${res.data.zeroRateNames.join(', ')} — their lines bill $0.`, {
          type: 'warn',
        });
      }
    });
  };

  const handleGenerate = () => {
    if (!preview || preview.lines.length === 0) {
      notify('Build a preview first.', { type: 'warn' });
      return;
    }
    const total = preview.totalUsd;
    startGenerate(async () => {
      const res = await generateInvoice({
        clientId,
        from,
        to,
        markupPct: Number(markup) || 0,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(`Invoice ${res.data.invoiceNo ?? ''} generated — ${money(total, 'USD')}.`, {
        type: 'success',
      });
      setPreview(null);
      router.refresh();
    });
  };

  const changeStatus = (invoiceId: string, status: 'sent' | 'paid' | 'void') => {
    if (status === 'void' && !window.confirm('Void this invoice? You can then regenerate it.')) {
      return;
    }
    startUpdate(async () => {
      const res = await setInvoiceStatus({ invoiceId, status });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(status === 'void' ? 'Invoice voided.' : `Marked ${status}.`, {
        type: 'success',
      });
      router.refresh();
    });
  };

  const exportPreviewCsv = () => {
    if (!preview) return;
    const content = [
      ['Contractor', 'Position', 'Hours', 'Rate USD', 'Amount USD'].map(csvEscape).join(','),
      ...preview.lines.map((l) =>
        [l.workerName, l.position ?? '', l.workedHours, l.billRateUsd, l.amountUsd]
          .map(csvEscape)
          .join(','),
      ),
      ['', '', '', 'Subtotal', preview.subtotalUsd].map(csvEscape).join(','),
      ['', '', '', `Total (+${preview.markupPct}%)`, preview.totalUsd].map(csvEscape).join(','),
    ].join('\n');
    downloadCsv(`invoice_${clientName || 'client'}_${from}_${to}.csv`, content);
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Invoicing</h2>
        <p className="sub">
          Invoice a client for worked hours × each contractor&apos;s USD bill rate. Paid time off is
          not billed (it&apos;s the employer&apos;s cost).
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            alignItems: 'flex-end',
          }}
        >
          <label style={{ minWidth: 200, flex: 1 }}>
            <span className="sub" style={labelStyle}>
              Client
            </span>
            <select
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                setPreview(null);
              }}
              style={{ width: '100%' }}
            >
              <option value="">— Select a client —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sub" style={labelStyle}>
              From
            </span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span className="sub" style={labelStyle}>
              To
            </span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label>
            <span className="sub" style={labelStyle}>
              Markup %
            </span>
            <input
              type="number"
              min="0"
              step="0.5"
              value={markup}
              onChange={(e) => setMarkup(e.target.value)}
              style={{ width: 90 }}
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={isPreviewing || !clientId}
            onClick={handlePreview}
          >
            {isPreviewing ? 'Building…' : 'Preview'}
          </button>
        </div>

        {preview && preview.lines.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Contractor</th>
                    <th>Position</th>
                    <th style={rightAlign}>Hours</th>
                    <th style={rightAlign}>Rate (USD/hr)</th>
                    <th style={rightAlign}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((l) => (
                    <tr key={l.workerId}>
                      <td>{l.workerName}</td>
                      <td>{l.position ?? '—'}</td>
                      <td style={rightAlign}>{l.workedHours.toFixed(2)}</td>
                      <td style={rightAlign}>{money(l.billRateUsd, 'USD')}</td>
                      <td style={rightAlign}>{money(l.amountUsd, 'USD')}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'right', fontWeight: 600 }}>
                      Subtotal
                    </td>
                    <td style={rightAlign}>{money(preview.subtotalUsd, 'USD')}</td>
                  </tr>
                  {preview.markupPct > 0 && (
                    <tr>
                      <td colSpan={4} style={rightAlign}>
                        Markup {preview.markupPct}%
                      </td>
                      <td style={rightAlign}>
                        {money(preview.totalUsd - preview.subtotalUsd, 'USD')}
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'right', fontWeight: 700 }}>
                      Total (USD)
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>
                      {money(preview.totalUsd, 'USD')}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="btn"
                disabled={isGenerating}
                onClick={handleGenerate}
              >
                {isGenerating ? 'Generating…' : 'Generate invoice'}
              </button>
              <button type="button" className="btn ghost" onClick={exportPreviewCsv}>
                Export CSV
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{clientId ? `Invoices — ${clientName}` : 'All invoices'}</h3>
        {history.length === 0 ? (
          <p className="sub">No invoices yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Client</th>
                  <th>Period</th>
                  <th style={rightAlign}>Total</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {history.map((i) => (
                  <tr key={i.id}>
                    <td>{i.invoiceNo ?? '—'}</td>
                    <td>{i.companyName}</td>
                    <td>
                      {fmtDate(i.periodStart)} – {fmtDate(i.periodEnd)}
                    </td>
                    <td style={rightAlign}>{money(i.totalUsd, 'USD')}</td>
                    <td>
                      <Badge tone={STATUS_TONE[i.status] ?? 'neutral'}>{i.status}</Badge>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Link
                          href={`/invoicing/${i.id}/print`}
                          target="_blank"
                          className="btn ghost sm"
                        >
                          Print
                        </Link>
                        {i.status === 'draft' && (
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={isUpdating}
                            onClick={() => changeStatus(i.id, 'sent')}
                          >
                            Mark sent
                          </button>
                        )}
                        {i.status === 'sent' && (
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={isUpdating}
                            onClick={() => changeStatus(i.id, 'paid')}
                          >
                            Mark paid
                          </button>
                        )}
                        {i.status !== 'void' && (
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={isUpdating}
                            onClick={() => changeStatus(i.id, 'void')}
                          >
                            Void
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
};
