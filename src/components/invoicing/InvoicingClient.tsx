'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState, useTransition } from 'react';
import {
  Badge,
  type BadgeTone,
  ConfirmDangerModal,
  Modal,
  Pagination,
  usePagination,
  useToast,
} from '@/components/ui';
import type { ClientOption, InvoiceListRow } from '@/db/queries/invoicing';
import { fmtDate, money } from '@/lib/format';
import { downloadCsv } from '@/lib/reports/csv';
import { syncHubstaffNow } from '@/server/actions/hubstaff';
import {
  generateInvoice,
  type InvoicePreviewResult,
  markInvoicePaid,
  previewInvoice,
  setInvoiceStatus,
} from '@/server/actions/invoicing';

interface Props {
  clients: ClientOption[];
  invoices: InvoiceListRow[];
  /** Employer company id — target of the Hubstaff time refresh (null if unconfigured). */
  employerId: string | null;
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

export const InvoicingClient = ({
  clients,
  invoices,
  employerId,
  defaultFrom,
  defaultTo,
}: Props) => {
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
  const [isSyncing, startSync] = useTransition();

  const clientName = clients.find((c) => c.id === clientId)?.name ?? '';
  const history = useMemo(
    () => (clientId ? invoices.filter((i) => i.companyId === clientId) : invoices),
    [invoices, clientId],
  );
  const pg = usePagination(history, 20, clientId);

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
        notify('No billable hours or sessions for this client in the window.', {
          type: 'warn',
        });
        return;
      }
      if (res.data.zeroRateNames.length > 0) {
        notify(
          `No USD bill rate for ${res.data.zeroRateNames.join(', ')} — their hourly lines bill $0.`,
          { type: 'warn' },
        );
      }
      if (res.data.zeroSessionRateNames.length > 0) {
        notify(
          `No USD session rate for ${res.data.zeroSessionRateNames.join(', ')} — their session lines bill $0.`,
          { type: 'warn' },
        );
      }
      if (res.data.multiClientNames.length > 0) {
        notify(
          `${res.data.multiClientNames.join(', ')} also serve other clients — only hours attributed to THIS client bill here; their unattributed hours are excluded (never double-billed). Attribute per-project to include them.`,
          { type: 'warn', persistent: true },
        );
      }
    });
  };

  const refreshFromHubstaff = () => {
    if (!employerId) {
      notify('No employer company configured.', { type: 'warn' });
      return;
    }
    startSync(async () => {
      const res = await syncHubstaffNow({
        companyId: employerId,
        periodStart: from,
        periodEnd: to,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(
        `Synced ${res.data.rowsWritten} time row(s) for ${res.data.window.start} → ${res.data.window.stop}.`,
        { type: 'success' },
      );
      if (clientId) handlePreview(); // re-price the preview against the fresh time
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

  const [pendingVoid, setPendingVoid] = useState<string | null>(null);
  const [payingInvoice, setPayingInvoice] = useState<InvoiceListRow | null>(null);
  const applyStatus = (invoiceId: string, status: 'sent' | 'void') => {
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
  const changeStatus = (invoiceId: string, status: 'sent' | 'void') => {
    if (status === 'void') {
      setPendingVoid(invoiceId);
      return;
    }
    applyStatus(invoiceId, status);
  };
  const confirmVoid = () => {
    const id = pendingVoid;
    if (!id) return;
    setPendingVoid(null);
    applyStatus(id, 'void');
  };
  const confirmPaid = (receipt: {
    amountReceivedUsd: number;
    receivedOn: string;
    paymentRef: string;
  }) => {
    const inv = payingInvoice;
    if (!inv) return;
    startUpdate(async () => {
      const res = await markInvoicePaid({ invoiceId: inv.id, ...receipt });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(`Marked paid — ${money(receipt.amountReceivedUsd, 'USD')} received.`, {
        type: 'success',
      });
      setPayingInvoice(null);
      router.refresh();
    });
  };

  const exportPreviewCsv = () => {
    if (!preview) return;
    const content = [
      ['Contractor', 'Position', 'Type', 'Qty', 'Unit rate USD', 'Amount USD']
        .map(csvEscape)
        .join(','),
      ...preview.lines.map((l) =>
        [
          l.workerName,
          l.position ?? '',
          l.kind === 'session' ? 'Sessions' : 'Hours',
          l.kind === 'session' ? l.sessionsCount : l.workedHours,
          l.kind === 'session' ? l.sessionRateUsd : l.billRateUsd,
          l.amountUsd,
        ]
          .map(csvEscape)
          .join(','),
      ),
      ['', '', '', '', 'Subtotal', preview.subtotalUsd].map(csvEscape).join(','),
      ['', '', '', '', `Total (+${preview.markupPct}%)`, preview.totalUsd].map(csvEscape).join(','),
    ].join('\n');
    downloadCsv(`invoice_${clientName || 'client'}_${from}_${to}.csv`, content);
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Invoicing</h2>
        <p className="sub">
          Invoice a client for worked hours × each contractor&apos;s USD bill rate, plus any
          flat-fee sessions (approved visits × the session rate). Paid time off is not billed
          (it&apos;s the employer&apos;s cost).
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
          {employerId && (
            <button
              type="button"
              className="btn ghost"
              disabled={isSyncing}
              onClick={refreshFromHubstaff}
              title="Pull the latest Hubstaff tracked time for this date range, then re-price the preview"
            >
              {isSyncing ? 'Syncing…' : '↻ Refresh from Hubstaff'}
            </button>
          )}
        </div>

        {preview && preview.lines.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="table-scroll">
              <table aria-label="Invoice preview lines">
                <thead>
                  <tr>
                    <th scope="col">Contractor</th>
                    <th scope="col">Position</th>
                    <th scope="col">Type</th>
                    <th scope="col" style={rightAlign}>
                      Qty
                    </th>
                    <th scope="col" style={rightAlign}>
                      Unit rate
                    </th>
                    <th scope="col" style={rightAlign}>
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((l) => (
                    <tr key={`${l.workerId}-${l.kind}`}>
                      <td>{l.workerName}</td>
                      <td>{l.position ?? '—'}</td>
                      <td>{l.kind === 'session' ? 'Sessions' : 'Hours'}</td>
                      <td style={rightAlign}>
                        {l.kind === 'session' ? l.sessionsCount : l.workedHours.toFixed(2)}
                      </td>
                      <td style={rightAlign}>
                        {l.kind === 'session'
                          ? `${money(l.sessionRateUsd, 'USD')}/visit`
                          : `${money(l.billRateUsd, 'USD')}/hr`}
                      </td>
                      <td style={rightAlign}>{money(l.amountUsd, 'USD')}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'right', fontWeight: 600 }}>
                      Subtotal
                    </td>
                    <td style={rightAlign}>{money(preview.subtotalUsd, 'USD')}</td>
                  </tr>
                  {preview.markupPct > 0 && (
                    <tr>
                      <td colSpan={5} style={rightAlign}>
                        Markup {preview.markupPct}%
                      </td>
                      <td style={rightAlign}>
                        {money(preview.totalUsd - preview.subtotalUsd, 'USD')}
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'right', fontWeight: 700 }}>
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
          <>
            <div className="table-scroll">
              <table aria-label="Invoice history">
                <thead>
                  <tr>
                    <th scope="col">Invoice #</th>
                    <th scope="col">Client</th>
                    <th scope="col">Period</th>
                    <th scope="col" style={rightAlign}>
                      Total
                    </th>
                    <th scope="col" style={rightAlign}>
                      Received
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pg.pageItems.map((i) => (
                    <tr key={i.id}>
                      <td>{i.invoiceNo ?? '—'}</td>
                      <td>{i.companyName}</td>
                      <td>
                        {fmtDate(i.periodStart)} – {fmtDate(i.periodEnd)}
                      </td>
                      <td style={rightAlign}>{money(i.totalUsd, 'USD')}</td>
                      <td style={rightAlign}>
                        {i.status === 'paid' && i.amountReceivedUsd != null ? (
                          <span title={i.paymentRef ?? undefined}>
                            {money(i.amountReceivedUsd, 'USD')}
                            {i.receivedOn && (
                              <span className="sub" style={{ display: 'block', fontSize: 11 }}>
                                {fmtDate(i.receivedOn)}
                              </span>
                            )}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
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
                              onClick={() => setPayingInvoice(i)}
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
            <Pagination
              page={pg.page}
              totalPages={pg.totalPages}
              total={pg.total}
              from={pg.from}
              to={pg.to}
              onPage={pg.setPage}
              noun="invoices"
            />
          </>
        )}
      </div>
      {pendingVoid != null && (
        <ConfirmDangerModal
          title="Void invoice"
          message="Void this invoice? You can then regenerate it for the same period."
          confirmLabel="Void invoice"
          onConfirm={confirmVoid}
          onCancel={() => setPendingVoid(null)}
        />
      )}
      {payingInvoice && (
        <InvoiceReceiptModal
          invoice={payingInvoice}
          isSaving={isUpdating}
          onConfirm={confirmPaid}
          onCancel={() => setPayingInvoice(null)}
        />
      )}
    </>
  );
};

const todayIso = (): string => new Date().toISOString().slice(0, 10);

interface InvoiceReceiptModalProps {
  invoice: InvoiceListRow;
  isSaving: boolean;
  onConfirm: (receipt: {
    amountReceivedUsd: number;
    receivedOn: string;
    paymentRef: string;
  }) => void;
  onCancel: () => void;
}

/** Captures the accounts-receivable receipt when marking an invoice paid. */
const InvoiceReceiptModal = ({
  invoice,
  isSaving,
  onConfirm,
  onCancel,
}: InvoiceReceiptModalProps) => {
  const amountId = useId();
  const dateId = useId();
  const refId = useId();
  const [amount, setAmount] = useState(invoice.totalUsd.toFixed(2));
  const [receivedOn, setReceivedOn] = useState(todayIso());
  const [paymentRef, setPaymentRef] = useState('');

  const amt = Number(amount);
  const validAmount = Number.isFinite(amt) && amt >= 0;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(receivedOn);
  const delta = validAmount ? amt - invoice.totalUsd : 0;

  const submit = () => {
    if (!validAmount || !validDate) return;
    onConfirm({ amountReceivedUsd: amt, receivedOn, paymentRef: paymentRef.trim() });
  };

  return (
    <Modal title="Record payment" onClose={onCancel} maxWidth={420}>
      <p className="sub">
        {invoice.invoiceNo ?? 'Invoice'} — invoiced total {money(invoice.totalUsd, 'USD')}. Record
        what was actually received.
      </p>
      <div className="field">
        <label htmlFor={amountId} style={labelStyle}>
          Amount received (USD)
        </label>
        <input
          id={amountId}
          type="number"
          min="0"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={dateId} style={labelStyle}>
          Received on
        </label>
        <input
          id={dateId}
          type="date"
          value={receivedOn}
          onChange={(e) => setReceivedOn(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={refId} style={labelStyle}>
          Reference (optional)
        </label>
        <input
          id={refId}
          type="text"
          maxLength={120}
          placeholder="Bank / Wise ref"
          value={paymentRef}
          onChange={(e) => setPaymentRef(e.target.value)}
        />
      </div>
      {validAmount && delta !== 0 && (
        <p className="sub" style={{ color: delta < 0 ? 'var(--warn)' : '#3730a3' }}>
          {delta < 0 ? `Short by ${money(-delta, 'USD')}` : `Over by ${money(delta, 'USD')}`}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={isSaving}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          onClick={submit}
          disabled={isSaving || !validAmount || !validDate}
        >
          {isSaving ? 'Saving…' : 'Mark paid'}
        </button>
      </div>
    </Modal>
  );
};
