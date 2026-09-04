'use client';

/**
 * Contracts tab — the contract of record and every version of it
 * (docs/CONTRACT-VERSIONS-PLAN.md §5). Self-contained like RateCard: owns its
 * data and its actions, so it sits outside the profile form. Sign lives in the
 * portal; countersign here is what writes the rate and (re)opens the engagement.
 */

import { useCallback, useEffect, useState, useTransition } from 'react';
import { Badge, type BadgeTone, Modal, Spinner, useToast } from '@/components/ui';
import type {
  ContractOfRecord,
  ContractVersion,
  ContractVersionStatus,
} from '@/db/queries/contracts';
import type { RosterWorker } from '@/db/queries/workers';
import { nextPeriod } from '@/lib/dates/periods';
import { fmtDate, money } from '@/lib/format';
import {
  addContractBackpay,
  countersignContractVersion,
  draftContractVersion,
  getContractBackpay,
  listContractVersions,
  sendContractVersion,
  voidContractVersion,
} from '@/server/actions/contracts';
import type { BackpayQuote } from '@/server/off-cycle';
import { CONTRACT_OPTIONS, type ContractType, todayManila } from '@/types/schemas/contractors';
import { Field } from './Field';
import { SECTION_H4 } from './types';

const TONE: Record<ContractVersionStatus, BadgeTone> = {
  draft: 'neutral',
  sent: 'warn',
  signed: 'warn',
  active: 'good',
  superseded: 'neutral',
  ended: 'neutral',
  void: 'bad',
};
const IN_FLIGHT: ReadonlySet<ContractVersionStatus> = new Set(['draft', 'sent', 'signed']);

type AddendumType = '' | 'scope_of_work' | 'other';
type DraftForm = {
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

/**
 * Prefill: the draft being edited as it is; else the version just voided, so a
 * fix to something the contractor hasn't signed yet doesn't mean retyping it;
 * else the contract of record with the effective date moved to the next pay
 * period (§3). A rehire gets a fresh start date too — the old engagement's is
 * not the new one (decision 7).
 */
const formFrom = (
  record: ContractOfRecord | null,
  draft: ContractVersion | null,
  latest: ContractVersion | null,
  worker: RosterWorker,
): DraftForm => {
  const next = nextPeriod(todayManila()).start;
  const resume = draft ?? (latest?.status === 'void' ? latest : null);
  const t = resume ?? record;
  return {
    ratePhp: t?.ratePhp != null ? String(t.ratePhp) : '',
    position: t?.position ?? worker.role ?? '',
    employmentType: t?.employmentType ?? worker.contract,
    schedule: t?.schedule ?? '',
    hoursPerWeek: t?.hoursPerWeek != null ? String(t.hoursPerWeek) : '',
    startDate:
      resume?.startDate ??
      (worker.linkStatus === 'ended' ? next : (record?.startDate ?? worker.hireDate ?? '')),
    effectiveFrom: resume?.effectiveFrom ?? next,
    addendumType: (t?.addendumType as AddendumType | null) ?? '',
    addendumText: t?.addendumText ?? '',
    noticeDays: String(t?.noticeDays ?? 15),
  };
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Props {
  worker: RosterWorker;
  companyId: string;
  /** Spread of the shell's tablist.panelProps() — makes this div the active tabpanel. */
  panelProps: { role: 'tabpanel'; id: string; 'aria-labelledby': string; tabIndex: number };
}

export function ContractsTab({ worker, companyId, panelProps }: Props) {
  const { notify } = useToast();
  const [data, setData] = useState<{
    record: ContractOfRecord | null;
    versions: ContractVersion[];
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, startBusy] = useTransition();
  const [form, setForm] = useState<DraftForm | null>(null);
  const [backpay, setBackpay] = useState<BackpayQuote | null>(null);

  const load = useCallback(async () => {
    const res = await listContractVersions({ workerId: worker.workerId, companyId });
    if (res.ok) setData(res.data);
    else notify(res.error, { type: 'error' });
    setLoaded(true);
    // Backpay only exists for a versioned record (the v1 read-through has no
    // effective date to be late against).
    const id = res.ok && res.data.record?.source === 'versioned' ? res.data.record.id : null;
    if (!id) {
      setBackpay(null);
      return;
    }
    const q = await getContractBackpay({ versionId: id });
    setBackpay(q.ok ? q.data : null);
  }, [worker.workerId, companyId, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const record = data?.record ?? null;
  const versions = data?.versions ?? [];
  const inFlight = versions.find((v) => IN_FLIGHT.has(v.status)) ?? null;
  const draft = inFlight?.status === 'draft' ? inFlight : null;
  const rehire = worker.linkStatus === 'ended';

  const saveDraft = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const ratePhp = Number(form.ratePhp);
    if (!form.ratePhp || Number.isNaN(ratePhp) || ratePhp < 0) {
      notify('Enter the semi-monthly rate.', { type: 'error' });
      return;
    }
    if (!ISO_DATE.test(form.startDate) || !ISO_DATE.test(form.effectiveFrom)) {
      notify('Enter both dates.', { type: 'error' });
      return;
    }
    const noticeDays = Number(form.noticeDays);
    if (!Number.isInteger(noticeDays) || noticeDays < 1) {
      notify('Enter the termination notice in whole days.', { type: 'error' });
      return;
    }
    startBusy(async () => {
      const res = await draftContractVersion({
        workerId: worker.workerId,
        companyId,
        ratePhp,
        position: form.position.trim() || null,
        employmentType: form.employmentType || null,
        schedule: form.schedule.trim() || null,
        hoursPerWeek: form.hoursPerWeek === '' ? null : Number(form.hoursPerWeek),
        startDate: form.startDate,
        effectiveFrom: form.effectiveFrom,
        addendumType: form.addendumType,
        addendumText: form.addendumText.trim() || null,
        noticeDays,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(`Draft saved — version ${res.data.version}.`, { type: 'success' });
      setForm(null);
      await load();
    });
  };

  const send = (v: ContractVersion) => {
    if (
      !window.confirm(
        `Send version ${v.version} for signature? This freezes the document as it stands today${
          rehire ? ' and restores their portal login so they can sign' : ''
        }.`,
      )
    )
      return;
    startBusy(async () => {
      const res = await sendContractVersion({ versionId: v.id });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      const login =
        res.data.login === 'created'
          ? ' Portal login created — credentials emailed.'
          : res.data.login === 'restored'
            ? ' Portal login restored.'
            : '';
      notify(
        res.data.emailSent
          ? `Version ${v.version} sent.${login}`
          : `Version ${v.version} is out for signature, but the email could not be sent — tell them to sign in.${login}`,
        { type: res.data.emailSent ? 'success' : 'warn' },
      );
      await load();
    });
  };

  const voidIt = (v: ContractVersion) => {
    const reason = window.prompt(`Void version ${v.version}? Optional reason:`);
    if (reason === null) return;
    startBusy(async () => {
      const res = await voidContractVersion({
        versionId: v.id,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(
        res.data.loginRevoked
          ? `Version ${v.version} voided — portal login revoked again.`
          : `Version ${v.version} voided.`,
        { type: 'success' },
      );
      await load();
    });
  };

  const countersign = (v: ContractVersion) => {
    if (
      !window.confirm(
        `Countersign version ${v.version}? This sets the rate to ${money(v.ratePhp)} / period from ${fmtDate(
          v.effectiveFrom,
        )}${rehire ? ` and reopens the engagement from ${fmtDate(v.startDate)}` : ''}.`,
      )
    )
      return;
    startBusy(async () => {
      const res = await countersignContractVersion({ versionId: v.id });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      const base = res.data.rehired
        ? `Version ${v.version} countersigned — engagement reopened.`
        : `Version ${v.version} is now the contract of record.`;
      notify(res.data.emailSent ? base : `${base} The email could not be sent.`, {
        type: res.data.emailSent ? 'success' : 'warn',
      });
      await load();
    });
  };

  const addBackpay = (q: BackpayQuote) => {
    if (!q.target) return;
    if (
      !window.confirm(
        `Add ${money(q.totalPhp)} backpay to the ${fmtDate(q.target.periodStart)} – ${fmtDate(
          q.target.periodEnd,
        )} period? It lands as an off-cycle line on their payroll row.`,
      )
    )
      return;
    startBusy(async () => {
      const res = await addContractBackpay({ versionId: q.versionId });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify(
        `${money(res.data.amountPhp)} backpay added (${res.data.count} period${res.data.count === 1 ? '' : 's'}).`,
        {
          type: 'success',
        },
      );
      await load();
    });
  };

  const update = <K extends keyof DraftForm>(key: K, value: DraftForm[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  return (
    <div
      {...panelProps}
      style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 8 }}
    >
      <section>
        <h4 style={SECTION_H4}>Contract of record</h4>
        {!loaded ? (
          <Spinner />
        ) : !record ? (
          <p className="sub" style={{ margin: 0 }}>
            No engagement at this company.
          </p>
        ) : (
          <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <div>
              <strong>Version {record.version}</strong>
              {record.source === 'legacy' && (
                <span className="muted" style={{ fontSize: 12 }}>
                  {' '}
                  · original agreement
                </span>
              )}
            </div>
            <div>{record.ratePhp != null ? `${money(record.ratePhp)} / period` : 'no rate'}</div>
            {record.position && <div>{record.position}</div>}
            {record.effectiveFrom && (
              <div className="muted" style={{ fontSize: 12 }}>
                effective {fmtDate(record.effectiveFrom)}
              </div>
            )}
            <div className="muted" style={{ fontSize: 12 }}>
              {record.signedAt ? `signed ${fmtDate(record.signedAt)}` : 'not signed'}
              {record.countersignedAt
                ? ` · countersigned ${fmtDate(record.countersignedAt)}`
                : ' · not countersigned'}
            </div>
            {record.id && (
              <a href={`/contracts/${record.id}/print`} target="_blank" rel="noopener">
                Print
              </a>
            )}
          </div>
        )}
      </section>

      {backpay && (backpay.lines.length > 0 || backpay.warnings.length > 0) && (
        <section style={{ marginTop: 24 }}>
          <h4 style={SECTION_H4}>Backpay</h4>
          <p className="sub" style={{ fontSize: 12, margin: '0 0 8px', maxWidth: 560 }}>
            Version {backpay.version} took effect on {fmtDate(backpay.effectiveFrom)}. Periods paid
            before it was countersigned were priced at the old rate; the first one is prorated by
            working days on or after the effective date.
          </p>
          {backpay.lines.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Paid</th>
                    <th>Old rate</th>
                    <th>Working days</th>
                    <th>Owed</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {backpay.lines.map((l) => (
                    <tr key={l.periodStart}>
                      <td>
                        {fmtDate(l.periodStart)} – {fmtDate(l.periodEnd)}
                      </td>
                      <td>
                        {money(l.paidPhp)}
                        {l.catchUpPhp > 0 && (
                          <span className="muted" style={{ fontSize: 11 }}>
                            {' '}
                            + {money(l.catchUpPhp)} catch-up
                          </span>
                        )}
                      </td>
                      <td>{money(l.oldRatePhp)}</td>
                      <td>
                        {l.coveredDays}/{l.totalDays}
                      </td>
                      <td>{money(l.owedPhp)}</td>
                      <td>
                        {l.addedPhp != null ? (
                          <Badge tone="good">added {money(l.addedPhp)}</Badge>
                        ) : l.owedPhp <= 0 ? (
                          <span className="muted">nothing owed</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {backpay.warnings.map((w) => (
            <p key={w} className="sub" style={{ fontSize: 12, margin: '6px 0 0' }}>
              ⚠ {w}
            </p>
          ))}
          {backpay.totalPhp > 0 && (
            <div className="row" style={{ marginTop: 10, gap: 12, alignItems: 'center' }}>
              <strong>Total {money(backpay.totalPhp)}</strong>
              {backpay.target ? (
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => addBackpay(backpay)}
                >
                  Add to {fmtDate(backpay.target.periodStart)} – {fmtDate(backpay.target.periodEnd)}
                </button>
              ) : (
                <span className="muted" style={{ fontSize: 12 }}>
                  No open period to add it to — open one on Payroll first.
                </span>
              )}
            </div>
          )}
        </section>
      )}

      <section style={{ marginTop: 24 }}>
        <div className="card-head">
          <div>
            <h4 style={{ ...SECTION_H4, margin: 0 }}>Versions</h4>
            <div className="sub" style={{ fontSize: 12, maxWidth: 460 }}>
              {rehire
                ? 'This engagement has ended. A new contract is the rehire path — the engagement reopens when it is countersigned.'
                : 'Any change to the rate, position, start date, employment type, schedule or hours is a new version the contractor signs and an admin countersigns.'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {loaded && record && !inFlight && (
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => setForm(formFrom(record, null, versions[0] ?? null, worker))}
              >
                New contract
              </button>
            )}
            {draft && (
              <>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={() => setForm(formFrom(record, draft, null, worker))}
                >
                  Edit draft
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => send(draft)}
                >
                  Send for signature
                </button>
              </>
            )}
            {inFlight?.status === 'signed' && (
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => countersign(inFlight)}
              >
                Countersign
              </button>
            )}
            {inFlight && (
              <button
                type="button"
                className="btn danger-outline sm"
                disabled={busy}
                onClick={() => voidIt(inFlight)}
              >
                Void
              </button>
            )}
          </div>
        </div>

        {loaded && versions.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            No versions yet — the original agreement is version 1.
          </p>
        ) : (
          versions.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Status</th>
                    <th>Rate</th>
                    <th>Effective</th>
                    <th>Sent</th>
                    <th>Signed</th>
                    <th>Countersigned</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.id}>
                      <td>v{v.version}</td>
                      <td>
                        <Badge
                          tone={TONE[v.status]}
                          {...(v.voidReason ? { title: v.voidReason } : {})}
                        >
                          {v.status}
                        </Badge>
                      </td>
                      <td>{money(v.ratePhp)}</td>
                      <td>
                        {fmtDate(v.effectiveFrom)}
                        {v.endedOn ? ` → ${fmtDate(v.endedOn)}` : ''}
                      </td>
                      <td>{v.sentAt ? fmtDate(v.sentAt) : '—'}</td>
                      <td>{v.signedAt ? fmtDate(v.signedAt) : '—'}</td>
                      <td>
                        {v.countersignedAt
                          ? `${fmtDate(v.countersignedAt)}${v.countersignedName ? ` · ${v.countersignedName}` : ''}`
                          : '—'}
                      </td>
                      <td>
                        {v.renderedBody && (
                          <a href={`/contracts/${v.id}/print`} target="_blank" rel="noopener">
                            Print
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </section>

      {form && (
        <Modal
          title={draft ? `Edit draft — version ${draft.version}` : 'New contract'}
          onClose={() => setForm(null)}
          maxWidth={640}
        >
          <form onSubmit={saveDraft} noValidate>
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
            <div
              className="actionbar"
              style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}
            >
              <button
                type="button"
                className="btn ghost"
                onClick={() => setForm(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button type="submit" className="btn" disabled={busy}>
                {busy ? <Spinner /> : 'Save draft'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
