'use client';

/**
 * Contract-change wizard (docs/CONTRACT-CHANGE-WIZARD-PLAN.md §4) — every new
 * version goes through here: Reason → Terms → Review, then Save draft or Send
 * for signature from Review. The reason sets defaults and never skips a step
 * (decision 2); reopening a draft lands on Review with everything editable
 * (decision 3). Slice 1: the Increase / Benefits / Package / Access steps
 * slot in between Terms and Review in later slices.
 */

import { useState, useTransition } from 'react';
import { Modal, Spinner, useToast } from '@/components/ui';
import type { ContractOfRecord, ContractVersion } from '@/db/queries/contracts';
import type { RosterWorker } from '@/db/queries/workers';
import { nextPeriod } from '@/lib/dates/periods';
import { fmtDate, money } from '@/lib/format';
import { draftContractVersion } from '@/server/actions/contracts';
import { CONTRACT_OPTIONS, type ContractType, todayManila } from '@/types/schemas/contractors';
import {
  CONTRACT_CHANGE_REASON_LABEL,
  type ContractChangeReason,
  ContractChangeReasonSchema,
} from '@/types/schemas/contracts';
import { Field } from './Field';

type AddendumType = '' | 'scope_of_work' | 'other';
type Form = {
  changeReason: ContractChangeReason | '';
  changeNote: string;
  ratePhp: string;
  position: string;
  employmentType: ContractType | '';
  schedule: string;
  hoursPerWeek: string;
  startDate: string;
  effectiveFrom: string;
  addendumType: AddendumType;
  addendumText: string;
  noticeDays: string;
};

const STEPS = ['Reason', 'Terms', 'Review'] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ADDENDUM_LABEL: Record<AddendumType, string> = {
  '': 'None',
  scope_of_work: 'Scope of work',
  other: 'Other',
};

/**
 * Prefill: the draft being edited as it is; else the version just voided, so a
 * fix to something the contractor hasn't signed yet doesn't mean retyping it;
 * else the contract of record with the effective date moved to the next pay
 * period (CONTRACT-VERSIONS-PLAN §3). A rehire gets a fresh start date too —
 * the old engagement's is not the new one (decision 7) — and Rehire as the reason.
 */
const formFrom = (
  record: ContractOfRecord,
  draft: ContractVersion | null,
  latest: ContractVersion | null,
  worker: RosterWorker,
): Form => {
  const next = nextPeriod(todayManila()).start;
  const rehire = worker.linkStatus === 'ended';
  const resume = draft ?? (latest?.status === 'void' ? latest : null);
  const t = resume ?? record;
  return {
    changeReason: resume?.changeReason ?? (rehire ? 'rehire' : ''),
    changeNote: resume?.changeNote ?? '',
    ratePhp: t.ratePhp != null ? String(t.ratePhp) : '',
    position: t.position ?? worker.role ?? '',
    employmentType: t.employmentType ?? worker.contract,
    schedule: t.schedule ?? '',
    hoursPerWeek: t.hoursPerWeek != null ? String(t.hoursPerWeek) : '',
    startDate: resume?.startDate ?? (rehire ? next : (record.startDate ?? worker.hireDate ?? '')),
    effectiveFrom: resume?.effectiveFrom ?? next,
    addendumType: (t.addendumType as AddendumType | null) ?? '',
    addendumText: t.addendumText ?? '',
    noticeDays: String(t.noticeDays ?? 15),
  };
};

const reasonValid = (f: Form): boolean =>
  ContractChangeReasonSchema.safeParse(f.changeReason).success &&
  (f.changeReason !== 'other' || f.changeNote.trim() !== '');

/** Same checks the schema makes, worded for the form. Null when the terms are fine. */
const termsError = (f: Form): string | null => {
  const rate = Number(f.ratePhp);
  if (!f.ratePhp || Number.isNaN(rate) || rate < 0) return 'Enter the semi-monthly rate.';
  if (!ISO_DATE.test(f.startDate) || !ISO_DATE.test(f.effectiveFrom)) return 'Enter both dates.';
  if (f.effectiveFrom < f.startDate) return 'Effective date cannot be before the start date.';
  const n = Number(f.noticeDays);
  if (!Number.isInteger(n) || n < 1) return 'Enter the termination notice in whole days.';
  return null;
};

const typeLabel = (t: ContractType | '' | null): string =>
  CONTRACT_OPTIONS.find((o) => o.value === t)?.label ?? '—';
const addendumLabel = (type: string | null, text: string | null): string =>
  type
    ? `${ADDENDUM_LABEL[type as AddendumType] ?? type}${text?.trim() ? ` — ${text.trim()}` : ''}`
    : 'None';

interface Props {
  worker: RosterWorker;
  companyId: string;
  record: ContractOfRecord;
  /** The draft being edited — opens on Review. Null for a new version. */
  draft: ContractVersion | null;
  /** The newest version of any status, for the void-prefill. */
  latest: ContractVersion | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  /** Send the version just saved; the caller owns the toasts and the reload. */
  onSend: (v: { id: string; version: number }) => Promise<void>;
}

export function ContractWizard({
  worker,
  companyId,
  record,
  draft,
  latest,
  onClose,
  onSaved,
  onSend,
}: Props) {
  const { notify } = useToast();
  const [form, setForm] = useState<Form>(() => formFrom(record, draft, latest, worker));
  const [step, setStep] = useState(draft ? STEPS.length - 1 : 0);
  const [busy, startBusy] = useTransition();
  const rehire = worker.linkStatus === 'ended';

  const update = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const valid = [reasonValid(form), termsError(form) === null, true];
  // A step is reachable once every step before it is valid.
  const reachable = (i: number) => valid.slice(0, i).every(Boolean);

  const submit = (andSend: boolean) => {
    const err = termsError(form);
    if (!reasonValid(form) || err) {
      notify(err ?? 'Pick a reason for the change.', { type: 'error' });
      return;
    }
    startBusy(async () => {
      const res = await draftContractVersion({
        workerId: worker.workerId,
        companyId,
        changeReason: form.changeReason,
        changeNote: form.changeNote.trim() || null,
        ratePhp: Number(form.ratePhp),
        position: form.position.trim() || null,
        employmentType: form.employmentType || null,
        schedule: form.schedule.trim() || null,
        hoursPerWeek: form.hoursPerWeek === '' ? null : Number(form.hoursPerWeek),
        startDate: form.startDate,
        effectiveFrom: form.effectiveFrom,
        addendumType: form.addendumType,
        addendumText: form.addendumText.trim() || null,
        noticeDays: Number(form.noticeDays),
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      if (andSend) {
        await onSend({ id: res.data.versionId, version: res.data.version });
      } else {
        notify(`Draft saved — version ${res.data.version}.`, { type: 'success' });
        await onSaved();
      }
      onClose();
    });
  };

  // Old vs new, side by side; a row whose text differs is the change.
  const rows: [string, string, string][] = [
    [
      'Rate / period',
      record.ratePhp != null ? money(record.ratePhp) : '—',
      form.ratePhp ? money(Number(form.ratePhp)) : '—',
    ],
    ['Position', record.position ?? '—', form.position.trim() || '—'],
    ['Employment type', typeLabel(record.employmentType), typeLabel(form.employmentType)],
    [
      'Hours per week',
      record.hoursPerWeek != null ? String(record.hoursPerWeek) : '—',
      form.hoursPerWeek || '—',
    ],
    ['Schedule', record.schedule ?? '—', form.schedule.trim() || '—'],
    [
      rehire ? 'New start date' : 'Start date',
      record.startDate ? fmtDate(record.startDate) : '—',
      form.startDate ? fmtDate(form.startDate) : '—',
    ],
    [
      'Terms apply to pay from',
      record.effectiveFrom ? fmtDate(record.effectiveFrom) : '—',
      form.effectiveFrom ? fmtDate(form.effectiveFrom) : '—',
    ],
    ['Termination notice', `${record.noticeDays} days`, `${form.noticeDays || '—'} days`],
    [
      'Addendum',
      addendumLabel(record.addendumType, record.addendumText),
      addendumLabel(form.addendumType, form.addendumText),
    ],
  ];

  return (
    <Modal
      title={draft ? `Edit draft — version ${draft.version}` : 'New contract'}
      onClose={onClose}
      maxWidth={720}
    >
      <ol style={{ display: 'flex', gap: 16, listStyle: 'none', padding: 0, margin: '0 0 14px' }}>
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              className="btn link sm"
              style={{ padding: 0, fontWeight: i === step ? 700 : 400 }}
              aria-current={i === step ? 'step' : undefined}
              disabled={busy || !reachable(i)}
              onClick={() => setStep(i)}
            >
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div>
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 8px' }}>
            <legend className="sub" style={{ fontSize: 12, padding: 0, marginBottom: 8 }}>
              Why is this contract changing? The contractor sees the reason on their portal and in
              the email; the note stays here.
            </legend>
            {ContractChangeReasonSchema.options
              .filter((r) => r !== 'rehire' || rehire)
              .map((r) => (
                <label
                  key={r}
                  style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}
                >
                  <input
                    type="radio"
                    name="cv-reason"
                    value={r}
                    checked={form.changeReason === r}
                    onChange={() => update('changeReason', r)}
                    disabled={busy}
                  />
                  {CONTRACT_CHANGE_REASON_LABEL[r]}
                </label>
              ))}
          </fieldset>
          <Field id="cv-note" label="Note (admin only)" required={form.changeReason === 'other'}>
            <textarea
              id="cv-note"
              rows={3}
              value={form.changeNote}
              onChange={(e) => update('changeNote', e.target.value)}
              disabled={busy}
            />
          </Field>
        </div>
      )}

      {step === 1 && (
        <div>
          <div className="grid-2">
            <Field id="cv-rate" label="Rate (PHP, semi-monthly)" required>
              <input
                id="cv-rate"
                type="number"
                min="0"
                step="0.01"
                value={form.ratePhp}
                onChange={(e) => update('ratePhp', e.target.value)}
                disabled={busy}
              />
            </Field>
            <Field id="cv-position" label="Position">
              <input
                id="cv-position"
                value={form.position}
                onChange={(e) => update('position', e.target.value)}
                disabled={busy}
              />
            </Field>
            <Field id="cv-type" label="Employment type">
              <select
                id="cv-type"
                value={form.employmentType}
                onChange={(e) => update('employmentType', e.target.value as ContractType | '')}
                disabled={busy}
              >
                <option value="">—</option>
                {CONTRACT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="cv-hours" label="Hours per week">
              <input
                id="cv-hours"
                type="number"
                min="0"
                max="168"
                value={form.hoursPerWeek}
                onChange={(e) => update('hoursPerWeek', e.target.value)}
                disabled={busy}
              />
            </Field>
            <Field id="cv-schedule" label="Schedule">
              <input
                id="cv-schedule"
                value={form.schedule}
                onChange={(e) => update('schedule', e.target.value)}
                placeholder="e.g. 9:00 AM – 5:00 PM Eastern Time"
                disabled={busy}
              />
            </Field>
            <Field id="cv-notice" label="Termination notice (days)" required>
              <input
                id="cv-notice"
                type="number"
                min="1"
                max="365"
                step="1"
                value={form.noticeDays}
                onChange={(e) => update('noticeDays', e.target.value)}
                disabled={busy}
              />
            </Field>
            <Field id="cv-start" label={rehire ? 'New start date' : 'Start date'} required>
              <input
                id="cv-start"
                type="date"
                value={form.startDate}
                onChange={(e) => update('startDate', e.target.value)}
                disabled={busy}
              />
            </Field>
            <Field id="cv-effective" label="Terms apply to pay from" required>
              <input
                id="cv-effective"
                type="date"
                min={form.startDate || undefined}
                value={form.effectiveFrom}
                onChange={(e) => update('effectiveFrom', e.target.value)}
                disabled={busy}
              />
            </Field>
            <Field id="cv-addendum-type" label="Addendum">
              <select
                id="cv-addendum-type"
                value={form.addendumType}
                onChange={(e) => update('addendumType', e.target.value as AddendumType)}
                disabled={busy}
              >
                <option value="">None</option>
                <option value="scope_of_work">Scope of work</option>
                <option value="other">Other</option>
              </select>
            </Field>
          </div>
          {form.addendumType && (
            <Field id="cv-addendum" label="Addendum text">
              <textarea
                id="cv-addendum"
                rows={4}
                value={form.addendumText}
                onChange={(e) => update('addendumText', e.target.value)}
                disabled={busy}
              />
            </Field>
          )}
        </div>
      )}

      {step === 2 && (
        <div>
          <p style={{ margin: '0 0 10px' }}>
            <strong>
              {form.changeReason ? CONTRACT_CHANGE_REASON_LABEL[form.changeReason] : '—'}
            </strong>
            {form.changeNote.trim() && (
              <span className="muted" style={{ fontSize: 12 }}>
                {' '}
                · {form.changeNote.trim()}
              </span>
            )}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Version {record.version}</th>
                  <th>New</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, from, to]) => {
                  const changed = from !== to;
                  return (
                    <tr key={label} style={changed ? { fontWeight: 600 } : undefined}>
                      <td className="muted" style={{ fontWeight: 400 }}>
                        {label}
                      </td>
                      <td>{from}</td>
                      <td>
                        {to}
                        {changed && (
                          <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>
                            {' '}
                            · changed
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="sub" style={{ fontSize: 12, margin: '10px 0 0' }}>
            Send freezes the document as it stands today
            {rehire ? ' and restores their portal login so they can sign' : ''}. Your current
            contract of record stays in force until the new version is countersigned.
          </p>
        </div>
      )}

      <div className="actionbar" style={{ marginTop: 16, justifyContent: 'space-between', gap: 8 }}>
        <button
          type="button"
          className="btn ghost"
          onClick={() => (step === 0 ? onClose() : setStep(step - 1))}
          disabled={busy}
        >
          {step === 0 ? 'Cancel' : 'Back'}
        </button>
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            className="btn"
            disabled={busy || !valid[step]}
            onClick={() => setStep(step + 1)}
          >
            Next
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => submit(false)}
            >
              Save draft
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => submit(true)}>
              {busy ? <Spinner /> : 'Send for signature'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
