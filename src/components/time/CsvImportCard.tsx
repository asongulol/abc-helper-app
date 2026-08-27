'use client';

/**
 * CSV Import Card — pure CSV parsing in-browser, attribution preview,
 * then a single server-action call to upsert the batch.
 *
 * Faithful to the legacy Option A (CSV upload) in TimeImport.
 * Header note: scheduled Hubstaff sync runs via the hubstaff-sync edge fn
 * (cron); this screen handles manual/CSV imports only.
 */

import { useRef, useState, useTransition } from 'react';
import { Badge, useToast } from '@/components/ui';
import type { PayPeriod } from '@/lib/dates/periods';
import type { RosterLink } from '@/lib/time/attribution';
import { buildMatchIndex, matchName } from '@/lib/time/attribution';
import type { HubstaffMember } from '@/lib/time/csv';
import { isParseError, parseHubstaffCsv } from '@/lib/time/csv';
import { addContractor } from '@/server/actions/contractors';
import { importCsvBatch } from '@/server/actions/time';
import {
  CONTRACT_OPTIONS,
  type ContractType,
  PAY_BASIS_OPTIONS,
  type PayBasis,
} from '@/types/schemas/contractors';
import { OptionBPanel } from './OptionBPanel';

interface CsvImportCardProps {
  companyId: string;
  roster: RosterLink[];
  /** Period the Hubstaff sync window starts on — the next unimported one. */
  period: PayPeriod;
  onImported: () => void;
}

/**
 * Split a Hubstaff display name into first/last — a PREFILL only; the admin
 * corrects it in the form before the contractor is created (RP-50).
 * Rule: last word is lastName, everything before is firstName.
 * Single-word names get a placeholder last name of '.'.
 */
const splitName = (name: string): { firstName: string; lastName: string } => {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0] ?? name, lastName: '.' };
  }
  const lastName = parts[parts.length - 1] ?? '';
  const firstName = parts.slice(0, parts.length - 1).join(' ');
  return { firstName, lastName };
};

/** The "add as contractor" draft — nothing is guessed except the name prefill. */
interface ContractorDraft {
  sourceName: string;
  firstName: string;
  lastName: string;
  /** '' until the admin picks — FT is a pay model, not a default (RP-50). */
  contract: ContractType | '';
  payBasis: PayBasis | '';
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

export const CsvImportCard = ({ companyId, roster, period, onImported }: CsvImportCardProps) => {
  const { notify } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parseErr, setParseErr] = useState('');
  const [parsed, setParsed] = useState<ParsedState | null>(null);
  const [mode, setMode] = useState<'upsert' | 'skip'>('upsert');
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<ContractorDraft | null>(null);

  const idx = buildMatchIndex(roster);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setParseErr('');
    setParsed(null);
    const reader = new FileReader();
    // Without this a read failure left the card looking like nothing happened (RP-48).
    reader.onerror = () =>
      setParseErr(
        `Could not read "${f.name}" — ${reader.error?.message ?? 'the file is unreadable'}.`,
      );
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
      setParsed({
        dates: result.dates,
        members,
        skippedRows: result.skippedRows,
      });
    };
    reader.readAsText(f);
  };

  // PHS is paid per unit and needs its basis; FT/PT are salaried and don't.
  const draftReady =
    draft !== null &&
    draft.firstName.trim() !== '' &&
    draft.lastName.trim() !== '' &&
    draft.contract !== '' &&
    (draft.contract !== 'PHS' || draft.payBasis !== '');

  const handleAddAsContractor = () => {
    if (!draft || !draftReady || draft.contract === '') return;
    startTransition(async () => {
      const res = await addContractor({
        companyId,
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        contract: draft.contract,
        payBasis: draft.contract === 'PHS' ? draft.payBasis : null,
        hubstaffName: draft.sourceName,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      setDraft(null);
      notify(`Created contractor "${draft.sourceName}" — re-import to include their hours.`, {
        type: 'success',
      });
      onImported();
    });
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
        parsed.dates
          // Skip days the member didn't track. Emitting them made Overwrite
          // mode blank every untracked day: PTO to 0 and approval back to
          // pending, including days already approved.
          .filter((d) => (m.daySeconds[d] ?? 0) > 0)
          .map((d) => ({
            sourceName: m.name,
            workerId: m.workerId,
            workDate: d,
            trackedSeconds: m.daySeconds[d] ?? 0,
            activityPct: m.activityPct,
          })),
      );
      if (rows.length === 0) {
        notify('No tracked hours in this file for the matched contractors.', { type: 'warn' });
        return;
      }

      const res = await importCsvBatch({ companyId, rows, mode });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      const { written, skipped, droppedAfterEnd } = res.data ?? {
        written: 0,
        skipped: 0,
        droppedAfterEnd: 0,
      };
      // A departed contractor still shows up in a Hubstaff export. Their days
      // after the last day aren't imported — say so, or the hours read as lost.
      const endedNote =
        droppedAfterEnd > 0
          ? ` ${droppedAfterEnd} day(s) fell after a contractor's last day and were not imported.`
          : '';
      if (written === 0) {
        notify(
          endedNote
            ? `Nothing imported.${endedNote}`
            : (res.message ?? 'All rows already exist — nothing new to import.'),
          { type: endedNote ? 'warn' : 'info', persistent: true },
        );
      } else {
        notify(
          `Imported ${written} entr${written === 1 ? 'y' : 'ies'} for ${matchedMembers.length} contractor(s)${skipped > 0 ? ` (${skipped} skipped — already imported or already decided).` : '.'}${endedNote}`,
          { type: 'success', persistent: true },
        );
      }
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
      <h2>Hubstaff time import</h2>
      <p className="sub">
        Two ways to bring in time. Rows match contractors by their <b>Hubstaff name</b>; imported
        hours stage as <b>pending</b> until approved below.
      </p>

      <div className="grid-2">
        <div>
          <span className="section-label">Option A — upload CSV</span>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
            Export the daily report from Hubstaff and drop the file here.
          </p>
          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'flex-end',
              flexWrap: 'wrap',
            }}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={onFile}
              disabled={pending}
            />
            {parsed && (
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: 'var(--muted)',
                    display: 'block',
                  }}
                >
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
        </div>
        <OptionBPanel
          key={period.start}
          companyId={companyId}
          period={period}
          onImported={onImported}
        />
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
                borderColor: 'var(--warn)',
                color: 'var(--warn)',
              }}
            >
              <strong>{unmatchedCount} Hubstaff name(s) could not be matched</strong> to a
              contractor. These rows will be skipped. Set up their profile (Contractors tab) and
              re-import to include them.
              <div
                style={{
                  marginTop: 6,
                  display: 'flex',
                  gap: 6,
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                {parsed.members
                  .filter((m) => !m.isMatched)
                  .map((m, i) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: parsed rows have no stable id; name alone can collide (two different people, same display name)
                      key={`${m.name}-${i}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <span className="pill warn">{m.name}</span>
                      <button
                        type="button"
                        className="btn ghost sm"
                        style={{ fontSize: 11, padding: '1px 6px' }}
                        disabled={pending}
                        aria-expanded={draft?.sourceName === m.name}
                        onClick={() =>
                          setDraft(
                            draft?.sourceName === m.name
                              ? null
                              : {
                                  sourceName: m.name,
                                  ...splitName(m.name),
                                  contract: '',
                                  payBasis: '',
                                },
                          )
                        }
                      >
                        {draft?.sourceName === m.name ? 'Cancel' : 'Add as contractor'}
                      </button>
                    </span>
                  ))}
              </div>
              {/* Name split and pay model are confirmed here — creating on a
                  guessed name with a hardcoded FT contract priced per-session
                  therapists on the salaried model (RP-50). */}
              {draft && (
                <div
                  style={{
                    marginTop: 10,
                    display: 'flex',
                    gap: 10,
                    flexWrap: 'wrap',
                    alignItems: 'flex-end',
                    color: 'var(--text)',
                  }}
                >
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>
                    First name
                    <input
                      value={draft.firstName}
                      onChange={(e) => setDraft({ ...draft, firstName: e.target.value })}
                      style={{ width: 140, display: 'block' }}
                      disabled={pending}
                    />
                  </label>
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>
                    Last name
                    <input
                      value={draft.lastName}
                      onChange={(e) => setDraft({ ...draft, lastName: e.target.value })}
                      style={{ width: 140, display: 'block' }}
                      disabled={pending}
                    />
                  </label>
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>
                    Contract
                    <select
                      value={draft.contract}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          contract: e.target.value as ContractType | '',
                          payBasis: '',
                        })
                      }
                      style={{ display: 'block' }}
                      disabled={pending}
                    >
                      <option value="">Choose…</option>
                      {CONTRACT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {draft.contract === 'PHS' && (
                    <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>
                      Paid per
                      <select
                        value={draft.payBasis}
                        onChange={(e) =>
                          setDraft({ ...draft, payBasis: e.target.value as PayBasis | '' })
                        }
                        style={{ display: 'block' }}
                        disabled={pending}
                      >
                        <option value="">Choose…</option>
                        {PAY_BASIS_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    className="btn sm"
                    disabled={pending || !draftReady}
                    onClick={handleAddAsContractor}
                  >
                    {pending ? 'Adding…' : `Create ${draft.sourceName}`}
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="table-scroll">
            <table aria-label="Hubstaff time import preview">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Attribution</th>
                  <th scope="col">Total tracked</th>
                  <th scope="col">Activity</th>
                  <th scope="col">Days</th>
                </tr>
              </thead>
              <tbody>
                {parsed.members.map((m, i) => {
                  const totalH = (
                    Object.values(m.daySeconds).reduce((s, v) => s + v, 0) / 3600
                  ).toFixed(2);
                  const daysWorked = Object.values(m.daySeconds).filter((v) => v > 0).length;
                  const tone = !m.isMatched ? 'bad' : m.isInactive ? 'warn' : 'good';
                  const label = !m.isMatched ? 'unmatched' : m.isInactive ? 'inactive' : 'matched';
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: parsed rows have no stable id; name alone can collide (two different people, same display name)
                    <tr key={`${m.name}-${i}`}>
                      <td className="card-title">
                        <b>{m.name}</b>
                      </td>
                      <td data-label="Attribution">
                        <Badge tone={tone}>{label}</Badge>
                      </td>
                      <td data-label="Total tracked">{totalH}h</td>
                      <td data-label="Activity">
                        {m.activityPct != null ? `${m.activityPct}%` : '—'}
                      </td>
                      <td data-label="Days">{daysWorked}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div
            style={{
              marginTop: 12,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            }}
          >
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
