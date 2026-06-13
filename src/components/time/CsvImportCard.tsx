'use client';

/**
 * CSV Import Card — pure CSV parsing in-browser, attribution preview,
 * then a single server-action call to upsert the batch.
 *
 * Faithful to the legacy Option A (CSV upload) in TimeImport.
 * Header note: scheduled Hubstaff sync runs via the hubstaff-sync edge fn
 * (cron); this screen handles manual/CSV imports only.
 */

import { Badge, useToast } from '@/components/ui';
import { buildMatchIndex, matchName } from '@/lib/time/attribution';
import type { RosterLink } from '@/lib/time/attribution';
import { isParseError, parseHubstaffCsv } from '@/lib/time/csv';
import type { HubstaffMember } from '@/lib/time/csv';
import { importCsvBatch } from '@/server/actions/time';
import { useRef, useState, useTransition } from 'react';

interface CsvImportCardProps {
  companyId: string;
  roster: RosterLink[];
  onImported: () => void;
}

interface ParsedState {
  dates: string[];
  members: Array<
    HubstaffMember & {
      workerId: string | null;
      isMatched: boolean;
      isInactive: boolean;
    }
  >;
  skippedRows: number;
}

export const CsvImportCard = ({ companyId, roster, onImported }: CsvImportCardProps) => {
  const { notify } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parseErr, setParseErr] = useState('');
  const [parsed, setParsed] = useState<ParsedState | null>(null);
  const [mode, setMode] = useState<'upsert' | 'skip'>('upsert');
  const [pending, startTransition] = useTransition();

  const idx = buildMatchIndex(roster);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setParseErr('');
    setParsed(null);
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const result = parseHubstaffCsv(text);
      if (isParseError(result)) {
        setParseErr(result.message);
        return;
      }
      const members = result.members.map((m) => {
        const hit = matchName(m.name, idx);
        return {
          ...m,
          workerId: hit?.workerId ?? null,
          isMatched: hit !== null,
          isInactive: hit?.isInactive ?? false,
        };
      });
      setParsed({ dates: result.dates, members, skippedRows: result.skippedRows });
    };
    reader.readAsText(f);
  };

  const handleImport = () => {
    if (!parsed) return;
    const matchedMembers = parsed.members.filter((m) => m.isMatched);
    if (matchedMembers.length === 0) {
      notify('No matched contractors to import.', { type: 'warn' });
      return;
    }

    startTransition(async () => {
      const rows = matchedMembers.flatMap((m) =>
        parsed.dates.map((d) => ({
          sourceName: m.name,
          workerId: m.workerId,
          workDate: d,
          trackedSeconds: m.daySeconds[d] ?? 0,
          activityPct: m.activityPct,
        })),
      );

      const res = await importCsvBatch({ companyId, rows, mode });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      const { written, skipped } = res.data ?? { written: 0, skipped: 0 };
      notify(
        `Imported ${written} entr${written === 1 ? 'y' : 'ies'} for ${matchedMembers.length} contractor(s)${skipped > 0 ? ` (${skipped} skipped — already existed).` : '.'}`,
        { type: 'success', persistent: true },
      );
      setParsed(null);
      if (fileRef.current) fileRef.current.value = '';
      onImported();
    });
  };

  const matchedCount = parsed?.members.filter((m) => m.isMatched && !m.isInactive).length ?? 0;
  const inactiveCount = parsed?.members.filter((m) => m.isMatched && m.isInactive).length ?? 0;
  const unmatchedCount = parsed?.members.filter((m) => !m.isMatched).length ?? 0;

  return (
    <div className="card">
      <h3 style={{ marginBottom: 4 }}>CSV Import</h3>
      <p className="sub" style={{ marginTop: 0, marginBottom: 12 }}>
        Export the <strong>daily report</strong> from Hubstaff and upload it here. Rows match
        contractors by their Hubstaff name; imported hours stage as <strong>pending</strong> until
        approved.
        <br />
        <span className="muted" style={{ fontSize: 12 }}>
          Note: the scheduled Hubstaff sync runs automatically via the hubstaff-sync edge function
          (cron). This screen is for manual or catch-up CSV imports.
        </span>
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>
            Hubstaff daily report (.csv)
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={onFile}
              disabled={pending}
            />
          </label>
        </div>
        {parsed && (
          <div>
            <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>
              Overlap handling
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'upsert' | 'skip')}
                disabled={pending}
              >
                <option value="upsert">Overwrite existing</option>
                <option value="skip">Skip already-imported rows</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {parseErr && (
        <div className="banner" style={{ marginTop: 10 }}>
          {parseErr}
        </div>
      )}

      {parsed && (
        <>
          <div style={{ marginTop: 12, marginBottom: 8 }}>
            <strong>
              Preview · {parsed.dates[0]} – {parsed.dates[parsed.dates.length - 1]}
            </strong>
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
              {matchedCount} matched · {unmatchedCount} unmatched
              {inactiveCount > 0 ? ` · ${inactiveCount} inactive` : ''}
              {parsed.skippedRows > 0 ? ` · ${parsed.skippedRows} totals row(s) skipped` : ''}
            </span>
          </div>

          {unmatchedCount > 0 && (
            <div
              className="banner"
              style={{
                marginBottom: 10,
                background: 'var(--warn-soft)',
                borderColor: '#fcd34d',
                color: '#92400e',
              }}
            >
              <strong>{unmatchedCount} Hubstaff name(s) could not be matched</strong> to a
              contractor. These rows will be skipped. Set up their profile (Contractors tab) and
              re-import to include them.
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {parsed.members
                  .filter((m) => !m.isMatched)
                  .map((m) => (
                    <span key={m.name} className="pill warn">
                      {m.name}
                    </span>
                  ))}
              </div>
            </div>
          )}

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Attribution</th>
                  <th>Total tracked</th>
                  <th>Activity</th>
                  <th>Days</th>
                </tr>
              </thead>
              <tbody>
                {parsed.members.map((m) => {
                  const totalH = (
                    Object.values(m.daySeconds).reduce((s, v) => s + v, 0) / 3600
                  ).toFixed(2);
                  const daysWorked = Object.values(m.daySeconds).filter((v) => v > 0).length;
                  const tone = !m.isMatched ? 'bad' : m.isInactive ? 'warn' : 'good';
                  const label = !m.isMatched ? 'unmatched' : m.isInactive ? 'inactive' : 'matched';
                  return (
                    <tr key={m.name}>
                      <td className="card-title">
                        <b>{m.name}</b>
                      </td>
                      <td>
                        <Badge tone={tone}>{label}</Badge>
                      </td>
                      <td>{totalH}h</td>
                      <td>{m.activityPct != null ? `${m.activityPct}%` : '—'}</td>
                      <td>{daysWorked}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="btn"
              disabled={pending || matchedCount === 0}
              onClick={handleImport}
            >
              {pending
                ? 'Importing…'
                : `Import ${matchedCount} contractor${matchedCount === 1 ? '' : 's'} → pending`}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={pending}
              onClick={() => {
                setParsed(null);
                if (fileRef.current) fileRef.current.value = '';
              }}
            >
              Clear
            </button>
          </div>
        </>
      )}
    </div>
  );
};
