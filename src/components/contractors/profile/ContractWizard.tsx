'use client';

/**
 * Contract-change wizard (docs/CONTRACT-CHANGE-WIZARD-PLAN.md §4) — every new
 * version goes through here: Reason → Terms → Increase → Review, then Save
 * draft or Send for signature from Review. The reason sets defaults and never
 * skips a step (decision 2); reopening a draft lands on Review with everything
 * editable (decision 3). The Increase step owns the rate (decision 4). The
 * Benefits step carries the four terms written to the worker at countersign
 * (decision 6). The Package step is the re-sign package (decision 8); Access
 * slots in before Review in a later slice.
 */

import { useState, useTransition } from 'react';
import { Modal, Spinner, useToast } from '@/components/ui';
import type { ContractOfRecord, ContractVersion } from '@/db/queries/contracts';
import type { RosterWorker } from '@/db/queries/workers';
import { monthlyFromPeriod } from '@/lib/agreements/merge';
import {
  applyIncrease,
  INCREASE_METHODS,
  type IncreaseDetail,
  type IncreaseMethod,
  increaseHow,
} from '@/lib/contracts/increase';
import {
  PACKAGE_KINDS,
  PACKAGE_TITLE,
  type PackageKind,
  packageLabels,
  packageWarning,
  resignDueOn,
} from '@/lib/contracts/package';
import { nextPeriod } from '@/lib/dates/periods';
import { fmtDate, money } from '@/lib/format';
import { draftContractVersion } from '@/server/actions/contracts';
import { requestDocument } from '@/server/actions/onboarding';
import { CONTRACT_OPTIONS, type ContractType, todayManila } from '@/types/schemas/contractors';
import {
  CONTRACT_CHANGE_REASON_LABEL,
  type ContractBenefits,
  type ContractChangeReason,
  ContractChangeReasonSchema,
} from '@/types/schemas/contracts';
import { Field } from './Field';

type AddendumType = '' | 'scope_of_work' | 'other';
type Form = {
  changeReason: ContractChangeReason | '';
  changeNote: string;
  /** Increase step: the rate measured from, how, and by how much (as typed). */
  base: IncreaseDetail['base'];
  method: IncreaseMethod;
  value: string;
  position: string;
  employmentType: ContractType | '';
  schedule: string;
  hoursPerWeek: string;
  startDate: string;
  effectiveFrom: string;
  addendumType: AddendumType;
  addendumText: string;
  noticeDays: string;
  /** Benefits step (decision 6): silent in the document, written to the worker at countersign. */
  healthAllowance: boolean;
  thirteenthMonth: boolean;
  holidayPay: boolean;
  ptoDaysPerYear: string;
  /** Package step: agreements the contractor re-signs after the contract (decision 8). */
  resignKinds: PackageKind[];
};

const STEPS = ['Reason', 'Terms', 'Increase', 'Benefits', 'Package', 'Review'] as const;
const BENEFIT_LABEL: Record<keyof Omit<ContractBenefits, 'ptoDaysPerYear'>, string> = {
  healthAllowance: 'Health allowance',
  thirteenthMonth: '13th month',
  holidayPay: 'Holiday pay',
};
const yesNo = (b: boolean): string => (b ? 'Yes' : 'No');
const isPackageKind = (k: string): k is PackageKind =>
  (PACKAGE_KINDS as readonly string[]).includes(k);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ADDENDUM_LABEL: Record<AddendumType, string> = {
  '': 'None',
  scope_of_work: 'Scope of work',
  other: 'Other',
};
const METHOD_LABEL: Record<IncreaseMethod, string> = {
  percent: 'Percent',
  flat: 'Flat amount',
  exact: 'Exact rate',
};
/** Annual Review / COLA land on the Increase step with percent selected (decision 2). */
const defaultMethod = (reason: ContractChangeReason | ''): IncreaseMethod =>
  reason === 'annual_review' || reason === 'cola' ? 'percent' : 'exact';

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
  const inc = resume?.changeDetail?.increase ?? null;
  // Prefilled from the worker's flags unless the draft already carries its own.
  const b = resume?.benefits ?? record.benefits;
  return {
    changeReason: resume?.changeReason ?? (rehire ? 'rehire' : ''),
    changeNote: resume?.changeNote ?? '',
    base: inc?.base ?? 'record',
    method: inc?.method ?? 'exact',
    value: inc ? String(inc.value) : t.ratePhp != null ? String(t.ratePhp) : '',
    position: t.position ?? worker.role ?? '',
    employmentType: t.employmentType ?? worker.contract,
    schedule: t.schedule ?? '',
    hoursPerWeek: t.hoursPerWeek != null ? String(t.hoursPerWeek) : '',
    startDate: resume?.startDate ?? (rehire ? next : (record.startDate ?? worker.hireDate ?? '')),
    effectiveFrom: resume?.effectiveFrom ?? next,
    addendumType: (t.addendumType as AddendumType | null) ?? '',
    addendumText: t.addendumText ?? '',
    noticeDays: String(t.noticeDays ?? 15),
    healthAllowance: b.healthAllowance,
    thirteenthMonth: b.thirteenthMonth,
    holidayPay: b.holidayPay,
    ptoDaysPerYear: String(b.ptoDaysPerYear),
    // Rehire pre-ticks the whole package; anything else starts blank (decision 8).
    resignKinds: resume
      ? resume.resignKinds.filter(isPackageKind)
      : rehire
        ? [...PACKAGE_KINDS]
        : [],
  };
};

const reasonValid = (f: Form): boolean =>
  ContractChangeReasonSchema.safeParse(f.changeReason).success &&
  (f.changeReason !== 'other' || f.changeNote.trim() !== '');

/** Same checks the schema makes, worded for the form. Null when the terms are fine. */
const termsError = (f: Form): string | null => {
  if (!ISO_DATE.test(f.startDate) || !ISO_DATE.test(f.effectiveFrom)) return 'Enter both dates.';
  if (f.effectiveFrom < f.startDate) return 'Effective date cannot be before the start date.';
  const n = Number(f.noticeDays);
  if (!Number.isInteger(n) || n < 1) return 'Enter the termination notice in whole days.';
  return null;
};

const benefitsOf = (f: Form): ContractBenefits | null =>
  /^\d+$/.test(f.ptoDaysPerYear)
    ? {
        healthAllowance: f.healthAllowance,
        thirteenthMonth: f.thirteenthMonth,
        holidayPay: f.holidayPay,
        ptoDaysPerYear: Number(f.ptoDaysPerYear),
      }
    : null;

const baseRate = (f: Form, record: ContractOfRecord): number | null =>
  f.base === 'live' ? record.liveRatePhp : record.ratePhp;

/** The Increase step's result, or null while it cannot be computed. */
const increaseOf = (f: Form, record: ContractOfRecord): IncreaseDetail | null => {
  if (f.value.trim() === '') return null;
  const from = baseRate(f, record);
  const value = Number(f.value);
  const to = applyIncrease(f.method, value, from);
  return to == null || to < 0 ? null : { method: f.method, value, from, to, base: f.base };
};

const increaseError = (f: Form, record: ContractOfRecord): string | null => {
  if (increaseOf(f, record)) return null;
  if (f.method === 'exact') return 'Enter the semi-monthly rate.';
  if (baseRate(f, record) == null) return 'There is no rate to change from — enter the exact rate.';
  return f.method === 'percent' ? 'Enter the percent.' : 'Enter the amount.';
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
  const [docTitle, setDocTitle] = useState('');
  const [requesting, startRequesting] = useTransition();
  const rehire = worker.linkStatus === 'ended';
  const liveDiffers =
    record.liveRatePhp != null && record.ratePhp != null && record.liveRatePhp !== record.ratePhp;

  const update = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  // A new reason resets the Increase step to its default; re-picking the same one keeps it.
  const pickReason = (r: ContractChangeReason) =>
    setForm((f) => {
      if (f.changeReason === r) return f;
      const method = defaultMethod(r);
      const from = baseRate(f, record);
      return {
        ...f,
        changeReason: r,
        method,
        value: method === 'exact' && from != null ? String(from) : '',
        ...(r === 'rehire' ? { resignKinds: [...PACKAGE_KINDS] } : {}),
      };
    });
  const toggleKind = (k: PackageKind) =>
    setForm((f) => ({
      ...f,
      resignKinds: f.resignKinds.includes(k)
        ? f.resignKinds.filter((x) => x !== k)
        : PACKAGE_KINDS.filter((x) => x === k || f.resignKinds.includes(x)),
    }));
  // Uploads use the existing Request a document (decision 8): it lands on their
  // owed list and emails them now, whether or not this version is ever sent.
  const requestDoc = () => {
    const title = docTitle.trim();
    if (!title) return;
    startRequesting(async () => {
      const res = await requestDocument({ workerId: worker.workerId, title });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(
        res.data.emailSent
          ? `${title} requested — they have been emailed.`
          : `${title} added to their owed list, but the email could not be sent.`,
        { type: res.data.emailSent ? 'success' : 'warn' },
      );
      setDocTitle('');
    });
  };
  const pickMethod = (method: IncreaseMethod) =>
    setForm((f) => {
      const from = baseRate(f, record);
      return { ...f, method, value: method === 'exact' && from != null ? String(from) : '' };
    });

  const inc = increaseOf(form, record);
  const benefits = benefitsOf(form);
  const valid = [
    reasonValid(form),
    termsError(form) === null,
    inc !== null,
    benefits !== null,
    true,
    true,
  ];
  // A step is reachable once every step before it is valid.
  const reachable = (i: number) => valid.slice(0, i).every(Boolean);

  const submit = (andSend: boolean) => {
    const err =
      termsError(form) ??
      increaseError(form, record) ??
      (benefits ? null : 'Enter the PTO days per year in whole days.');
    if (!reasonValid(form) || err || !inc || !benefits) {
      notify(err ?? 'Pick a reason for the change.', { type: 'error' });
      return;
    }
    startBusy(async () => {
      const res = await draftContractVersion({
        workerId: worker.workerId,
        companyId,
        changeReason: form.changeReason,
        changeNote: form.changeNote.trim() || null,
        changeDetail: { increase: inc },
        benefits,
        ratePhp: inc.to,
        position: form.position.trim() || null,
        employmentType: form.employmentType || null,
        schedule: form.schedule.trim() || null,
        hoursPerWeek: form.hoursPerWeek === '' ? null : Number(form.hoursPerWeek),
        startDate: form.startDate,
        effectiveFrom: form.effectiveFrom,
        addendumType: form.addendumType,
        addendumText: form.addendumText.trim() || null,
        noticeDays: Number(form.noticeDays),
        resignKinds: form.resignKinds,
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

  const how = inc ? increaseHow(inc) : null;
  // Decision 9: due at the end of the period after the send period — quoted as
  // of today; the real date is stamped at send.
  const dueIfSentToday = resignDueOn(todayManila());
  // Old vs new, side by side; a row whose text differs is the change.
  const rows: [string, string, string][] = [
    [
      'Rate / period',
      record.ratePhp != null ? money(record.ratePhp) : '—',
      inc ? `${money(inc.to)}${how ? ` · ${how}` : ''}` : '—',
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
    ...(Object.keys(BENEFIT_LABEL) as (keyof typeof BENEFIT_LABEL)[]).map(
      (k): [string, string, string] => [
        BENEFIT_LABEL[k],
        yesNo(record.benefits[k]),
        yesNo(form[k]),
      ],
    ),
    [
      'PTO days per year',
      String(record.benefits.ptoDaysPerYear),
      form.ptoDaysPerYear.trim() || '—',
    ],
    [
      'Re-sign package',
      'None',
      form.resignKinds.length
        ? `${packageLabels(form.resignKinds)} · due ${fmtDate(dueIfSentToday)} if sent today`
        : 'None',
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
                    onChange={() => pickReason(r)}
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
          {liveDiffers && (
            <fieldset style={{ border: 0, padding: 0, margin: '0 0 10px' }}>
              <legend className="sub" style={{ fontSize: 12, padding: 0, marginBottom: 6 }}>
                The contract of record and the rate row disagree — pick the base.
              </legend>
              {(['record', 'live'] as const).map((b) => (
                <label
                  key={b}
                  style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}
                >
                  <input
                    type="radio"
                    name="cv-base"
                    checked={form.base === b}
                    onChange={() => update('base', b)}
                    disabled={busy}
                  />
                  {b === 'record'
                    ? `Contract of record, version ${record.version} — ${money(record.ratePhp)}`
                    : `Rate row — ${money(record.liveRatePhp)}`}
                </label>
              ))}
            </fieldset>
          )}
          <div className="grid-2">
            <Field id="cv-method" label="Change">
              <select
                id="cv-method"
                value={form.method}
                onChange={(e) => pickMethod(e.target.value as IncreaseMethod)}
                disabled={busy}
              >
                {INCREASE_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id="cv-value"
              label={
                form.method === 'percent'
                  ? 'Percent (negative for a decrease)'
                  : form.method === 'flat'
                    ? 'Amount per period (PHP, negative for a decrease)'
                    : 'Rate (PHP, semi-monthly)'
              }
              required
            >
              <input
                id="cv-value"
                type="number"
                step={form.method === 'percent' ? '0.1' : '0.01'}
                min={form.method === 'exact' ? '0' : undefined}
                value={form.value}
                onChange={(e) => update('value', e.target.value)}
                disabled={busy}
              />
            </Field>
          </div>
          <p style={{ margin: '4px 0 0' }}>
            {inc ? (
              <>
                New rate <strong>{money(inc.to)}</strong> per period · PHP{' '}
                {monthlyFromPeriod(inc.to) || '0'} per month
                {inc.from != null && how && (
                  <span className="muted">
                    {' '}
                    (from {money(inc.from)} · {how})
                  </span>
                )}
              </>
            ) : (
              <span className="muted">{increaseError(form, record)}</span>
            )}
          </p>
          {form.method === 'percent' && (
            <p className="sub" style={{ fontSize: 12, margin: '6px 0 0' }}>
              Percent rounds to the nearest peso.
            </p>
          )}
        </div>
      )}

      {step === 3 && (
        <div>
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 10px' }}>
            <legend className="sub" style={{ fontSize: 12, padding: 0, marginBottom: 8 }}>
              Benefits on this version. Not in the document — written to their profile when the
              version is countersigned. Calculate’s treatment of holidays and PTO is unchanged.
            </legend>
            {(Object.keys(BENEFIT_LABEL) as (keyof typeof BENEFIT_LABEL)[]).map((k) => (
              <label
                key={k}
                style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}
              >
                <input
                  type="checkbox"
                  checked={form[k]}
                  onChange={(e) => update(k, e.target.checked)}
                  disabled={busy}
                />
                {BENEFIT_LABEL[k]}
              </label>
            ))}
          </fieldset>
          <Field id="cv-pto" label="PTO days per year" required>
            <input
              id="cv-pto"
              type="number"
              min="0"
              max="365"
              step="1"
              style={{ width: 96 }}
              value={form.ptoDaysPerYear}
              onChange={(e) => update('ptoDaysPerYear', e.target.value)}
              disabled={busy}
            />
          </Field>
          <p className="sub" style={{ fontSize: 12, margin: '4px 0 0' }}>
            Accrues at 12 days per 2,080 approved hours, capped here; the balance carries over up to
            30 days. Reference only.
          </p>
        </div>
      )}

      {step === 4 && (
        <div>
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 10px' }}>
            <legend className="sub" style={{ fontSize: 12, padding: 0, marginBottom: 8 }}>
              Agreements to re-sign after the contract, in this order. Their current signatures are
              superseded when the version is sent.
            </legend>
            {PACKAGE_KINDS.map((k) => (
              <label
                key={k}
                style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}
              >
                <input
                  type="checkbox"
                  checked={form.resignKinds.includes(k)}
                  onChange={() => toggleKind(k)}
                  disabled={busy}
                />
                {PACKAGE_TITLE[k]}
              </label>
            ))}
          </fieldset>
          <p className="sub" style={{ fontSize: 12, margin: '0 0 12px' }}>
            {form.resignKinds.length === 0
              ? 'Nothing to re-sign — the contractor signs the contract only.'
              : rehire
                ? 'A rehire’s package blocks countersign until everything is signed.'
                : `${packageWarning(dueIfSentToday)} The pay period that contains the send date is never held. The contractor is told in the send email, on the portal, and in a reminder three days before.`}
          </p>
          <Field id="cv-doc" label="Also request a document (emails them now)">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="cv-doc"
                value={docTitle}
                onChange={(e) => setDocTitle(e.target.value)}
                placeholder="e.g. Updated NBI clearance"
                disabled={busy || requesting}
              />
              <button
                type="button"
                className="btn ghost sm"
                disabled={busy || requesting || !docTitle.trim()}
                onClick={requestDoc}
              >
                {requesting ? <Spinner /> : 'Request'}
              </button>
            </div>
          </Field>
        </div>
      )}

      {step === 5 && (
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
            {rehire ? ' and restores their portal login so they can sign' : ''}. Pay from{' '}
            {fmtDate(form.effectiveFrom)} is priced at the new rate as soon as it is sent; the
            current contract of record stays in force until the new version is countersigned.
            {form.resignKinds.length > 0 &&
              (rehire
                ? ' Countersign waits until the whole package is signed.'
                : ` ${packageWarning(dueIfSentToday)}`)}
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
