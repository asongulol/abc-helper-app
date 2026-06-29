'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Modal, useToast } from '@/components/ui';
import { type ImportRow, importContractors } from '@/server/actions/import';

interface Props {
  companyId: string;
  onClose: () => void;
}

/** Map a flexible header cell to one of our row fields. */
const HEADER_MAP: Record<string, keyof ImportRow | 'name'> = {
  name: 'name',
  'full name': 'name',
  contractor: 'name',
  'first name': 'firstName',
  firstname: 'firstName',
  first: 'firstName',
  'last name': 'lastName',
  lastname: 'lastName',
  last: 'lastName',
  email: 'email',
  rate: 'ratePhp',
  'rate php': 'ratePhp',
  'wise recipient id': 'wiseRecipientId',
  'wise id': 'wiseRecipientId',
  'recipient id': 'wiseRecipientId',
  'wise uuid': 'wiseUuid',
  uuid: 'wiseUuid',
  hubstaff: 'hubstaffName',
  'hubstaff name': 'hubstaffName',
};

const TEMPLATE =
  'Name,Email,Rate,Wise recipient id,Wise UUID,Hubstaff name\nJuan Dela Cruz,juan@example.com,18000,79bf2801,33e5...,Juan Dela Cruz\n';

/** Parse pasted/CSV text (header row required) into typed import rows. */
function parseRows(text: string): { rows: ImportRow[]; error: string | null } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return { rows: [], error: 'Add a header row and at least one data row.' };

  const delim = (lines[0] ?? '').includes('\t') ? '\t' : ',';
  const split = (l: string) => l.split(delim).map((c) => c.trim());
  const header = split(lines[0] ?? '').map((h) => h.toLowerCase());
  const cols = header.map((h) => HEADER_MAP[h] ?? null);

  if (!cols.some((c) => c === 'name' || c === 'firstName')) {
    return {
      rows: [],
      error: 'Need a "Name" (or "First name"/"Last name") column.',
    };
  }

  const rows: ImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = split(lines[i] ?? '');
    let firstName = '';
    let lastName = '';
    const row: Partial<ImportRow> = {};
    cells.forEach((val, idx) => {
      const field = cols[idx];
      if (!field || !val) return;
      if (field === 'name') {
        const parts = val.split(/\s+/);
        firstName = parts[0] ?? '';
        lastName = parts.slice(1).join(' ');
      } else if (field === 'firstName') firstName = val;
      else if (field === 'lastName') lastName = val;
      else if (field === 'ratePhp') {
        const n = Number(val.replace(/[^0-9.]/g, ''));
        if (Number.isFinite(n) && n > 0) row.ratePhp = n;
      } else if (field === 'wiseRecipientId') {
        const n = Number(val.replace(/[^0-9]/g, ''));
        if (Number.isFinite(n) && n > 0) row.wiseRecipientId = n;
      } else if (field === 'wiseUuid') row.wiseUuid = val;
      else if (field === 'email') row.email = val;
      else if (field === 'hubstaffName') row.hubstaffName = val;
    });
    if (!firstName) continue;
    rows.push({ ...row, firstName, lastName });
  }
  if (rows.length === 0) return { rows: [], error: 'No valid rows found.' };
  return { rows, error: null };
}

export const BulkImportModal = ({ companyId, onClose }: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [raw, setRaw] = useState('');
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [preferWiseName, setPreferWiseName] = useState(true);
  const [isPending, startTransition] = useTransition();

  const handlePreview = () => {
    const { rows: parsed, error } = parseRows(raw);
    if (error) {
      notify(error, { type: 'error' });
      setRows([]);
      return;
    }
    setRows(parsed);
    notify(`${parsed.length} row(s) ready to import.`, { type: 'success' });
  };

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setRaw(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const downloadTemplate = () => {
    const blob = new Blob([TEMPLATE], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contractors-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    if (rows.length === 0) {
      notify('Preview some rows first.', { type: 'warn' });
      return;
    }
    startTransition(async () => {
      const res = await importContractors({ companyId, rows, preferWiseName });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      const { created, updated, errors } = res.data;
      notify(
        `Imported — ${created} created, ${updated} updated${errors.length ? `, ${errors.length} error(s)` : ''}.`,
        {
          type: errors.length ? 'warn' : 'success',
        },
      );
      router.refresh();
      if (errors.length === 0) onClose();
    });
  };

  return (
    <Modal title="Bulk import contractors" onClose={onClose} maxWidth={760}>
      <p className="sub">
        Paste from a spreadsheet or upload a CSV. Existing contractors are matched{' '}
        <b>by Wise recipient id/UUID first</b>, then Hubstaff id, then name — and{' '}
        <b>updated in place</b>. Single company.
      </p>

      <textarea
        rows={6}
        value={raw}
        aria-label="Paste contractor rows"
        onChange={(e) => setRaw(e.target.value)}
        placeholder="Name	Wise recipient id	Wise UUID	Rate	Email&#10;Manuella Gamboa	79bf2801	33e5...	18000	manuella@x.com"
        style={{ width: '100%' }}
      />

      <label
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
          margin: '10px 0',
          fontSize: 13,
        }}
      >
        <input
          type="checkbox"
          checked={preferWiseName}
          onChange={(e) => setPreferWiseName(e.target.checked)}
        />
        <span>
          Prefer the Wise account name for rows with a Wise recipient id (fetched from Wise so the
          DB name matches payouts). Falls back to the sheet name when Wise can't return one.
        </span>
      </label>

      <div className="actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
        <label className="sub" style={{ cursor: 'pointer' }}>
          …or upload CSV:{' '}
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </label>
        <button type="button" className="btn ghost sm" onClick={downloadTemplate}>
          ⬇ Download CSV template
        </button>
        <button type="button" className="btn" onClick={handlePreview}>
          Preview
        </button>
      </div>

      <details style={{ marginTop: 12 }}>
        <summary className="sub" style={{ cursor: 'pointer' }}>
          Accepted columns (header names are flexible)
        </summary>
        <p className="sub" style={{ marginTop: 6, lineHeight: 1.6 }}>
          <b>Name</b> (or First name / Last name) · <b>Wise recipient id</b> · <b>Wise UUID</b> ·
          Payout method (wise/bpi/gcash/paymaya/paypal) · Rate · Rate effective (YYYY-MM-DD) · Email
          · Mobile · Role · Contract (FT/PT) · Hubstaff user id · Hubstaff name · Hire date · Date
          of birth · PH address · GCash · PayMaya · PayPal · Health allowance (yes/no) · 13th month
          (yes/no) · Status (active/ended) · Started on (YYYY-MM-DD) · Ended on (YYYY-MM-DD).
          <br />
          Blank cells are left untouched on existing contractors — nothing is wiped by an empty
          column. <code>payout_account</code> (bank details) is intentionally excluded — the app
          never stores raw bank details, only Wise recipient references.
        </p>
      </details>

      {rows.length > 0 && (
        <div className="table-scroll" style={{ marginTop: 12, maxHeight: 260 }}>
          <table aria-label="Contractors to import">
            <thead>
              <tr>
                <th scope="col">First</th>
                <th scope="col">Last</th>
                <th scope="col">Email</th>
                <th scope="col">Rate</th>
                <th scope="col">Wise id</th>
                <th scope="col">Hubstaff</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.email ?? `${r.firstName}-${r.lastName}-${r.wiseRecipientId ?? ''}`}>
                  <td>{r.firstName}</td>
                  <td>{r.lastName}</td>
                  <td>{r.email ?? '—'}</td>
                  <td>{r.ratePhp ?? '—'}</td>
                  <td>{r.wiseRecipientId ?? '—'}</td>
                  <td>{r.hubstaffName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div className="actions">
          <button type="button" className="btn" onClick={handleImport} disabled={isPending}>
            {isPending ? 'Importing…' : `Import ${rows.length} contractor(s)`}
          </button>
        </div>
      )}
    </Modal>
  );
};
