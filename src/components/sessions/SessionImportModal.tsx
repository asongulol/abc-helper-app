'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { Modal, useToast } from '@/components/ui';
import { parseSessionCsv } from '@/lib/sessions/import-csv';
import { type ClientWorker, importSessions } from '@/server/actions/sessions';

interface Props {
  clientId: string;
  roster: ClientWorker[];
  onClose: () => void;
  onImported: () => void;
}

/** Admin bulk-import of sessions from a pasted/uploaded CSV, previewed before import. */
export const SessionImportModal = ({ clientId, roster, onClose, onImported }: Props) => {
  const { notify } = useToast();
  const [raw, setRaw] = useState('');
  const [isImporting, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const rosterByName = useMemo(
    () => new Map(roster.map((r) => [r.workerName.toLowerCase(), r.workerId])),
    [roster],
  );
  const result = useMemo(
    () => (raw.trim() ? parseSessionCsv(raw, rosterByName) : null),
    [raw, rosterByName],
  );

  const handleFile = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setRaw(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const doImport = () => {
    if (!result || result.rows.length === 0) {
      notify('Nothing to import.', { type: 'warn' });
      return;
    }
    start(async () => {
      const res = await importSessions({ clientId, rows: result.rows });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(
        `Imported ${res.data.created} session(s)${res.data.skipped ? `, skipped ${res.data.skipped}` : ''}.`,
        { type: 'success' },
      );
      onImported();
      onClose();
    });
  };

  return (
    <Modal title="Import sessions from CSV" onClose={onClose} maxWidth={620}>
      <p className="sub">
        Columns: <b>contractor</b>, <b>date</b> (YYYY-MM-DD), units, type, child, eiid, case, notes.
        Contractor names must match this client&apos;s active roster. Imported sessions start as
        pending.
      </p>
      <div style={{ marginBottom: 8 }}>
        <button type="button" className="btn ghost sm" onClick={() => fileRef.current?.click()}>
          Choose CSV file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
      </div>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder="Paste CSV here, or choose a file above"
        rows={8}
        aria-label="CSV content"
        style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
      />
      {result && (
        <div style={{ marginTop: 10 }}>
          <p className="sub" style={{ margin: 0 }}>
            <b>{result.rows.length}</b> row(s) ready
            {result.errors.length ? ` · ${result.errors.length} problem(s)` : ''}.
          </p>
          {result.errors.length > 0 && (
            <ul
              style={{
                margin: '6px 0 0',
                paddingLeft: 18,
                color: 'var(--bad)',
                fontSize: 12,
                maxHeight: 140,
                overflowY: 'auto',
              }}
            >
              {result.errors.slice(0, 50).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
        <button type="button" className="btn ghost" onClick={onClose} disabled={isImporting}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          onClick={doImport}
          disabled={isImporting || !result || result.rows.length === 0}
        >
          {isImporting ? 'Importing…' : `Import ${result?.rows.length ?? 0}`}
        </button>
      </div>
    </Modal>
  );
};
