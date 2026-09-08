'use client';

/**
 * Contracts tab — the contract of record and every version of it
 * (docs/CONTRACT-VERSIONS-PLAN.md §5). Self-contained like RateCard: owns its
 * data and its actions, so it sits outside the profile form. Sign lives in the
 * portal; countersign here is what writes the rate and (re)opens the engagement.
 */

import { useCallback, useEffect, useState, useTransition } from 'react';
import { Badge, type BadgeTone, Spinner, useToast } from '@/components/ui';
import type {
  ContractOfRecord,
  ContractVersion,
  ContractVersionStatus,
} from '@/db/queries/contracts';
import type { RosterWorker } from '@/db/queries/workers';
import { describeIncrease } from '@/lib/contracts/increase';
import { packageLabels } from '@/lib/contracts/package';
import { fmtDate, money } from '@/lib/format';
import {
  addContractBackpay,
  countersignContractVersion,
  getContractBackpay,
  listContractVersions,
  sendContractVersion,
  voidContractVersion,
} from '@/server/actions/contracts';
import type { BackpayQuote } from '@/server/off-cycle';
import { CONTRACT_CHANGE_REASON_LABEL } from '@/types/schemas/contracts';
import { ContractWizard } from './ContractWizard';
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
  const [showVoid, setShowVoid] = useState(false);
  const [busy, startBusy] = useTransition();
  /** The wizard, open on a new version (draft null) or on the existing draft. */
  const [wizard, setWizard] = useState<{ draft: ContractVersion | null } | null>(null);
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

  // The wizard's Review step is its own confirmation; the row button asks first.
  const sendNow = async (v: { id: string; version: number }) => {
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
    startBusy(() => sendNow(v));
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
      const { loginRevoked, overpaymentPhp, lockedAtNewRate } = res.data;
      const parts = [
        loginRevoked
          ? `Version ${v.version} voided — portal login revoked again.`
          : `Version ${v.version} voided.`,
      ];
      if (overpaymentPhp != null)
        parts.push(
          `${overpaymentPhp > 0 ? 'Overpaid' : 'Underpaid'} ${money(Math.abs(overpaymentPhp))} on pay already made at its rate — noted below, nothing is clawed back.`,
        );
      if (lockedAtNewRate.length)
        parts.push(`Locked at its rate: ${lockedAtNewRate.join(', ')} — unlock and recalculate.`);
      notify(parts.join(' '), { type: parts.length > 1 ? 'warn' : 'success' });
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
                onClick={() => setWizard({ draft: null })}
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
                  onClick={() => setWizard({ draft })}
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

        {/* Wizard decision 5: a version withdrawn after it priced paid periods
            leaves the amount here — a note for a human, never a clawback. */}
        {versions
          .flatMap((v) =>
            v.changeDetail?.overpayment ? [[v, v.changeDetail.overpayment] as const] : [],
          )
          .map(([v, o]) => (
            <p
              key={v.id}
              className="sub"
              style={{ fontSize: 12, margin: '0 0 8px', color: 'var(--bad)' }}
            >
              ⚠ {o.amountPhp > 0 ? 'Overpaid' : 'Underpaid'} {money(Math.abs(o.amountPhp))} —
              version {v.version} was withdrawn on {fmtDate(o.notedAt)} after {o.periods.join(', ')}{' '}
              had been paid at {money(o.ratePhp)}. No automatic clawback; settle it by hand.
            </p>
          ))}

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
                  {versions
                    .filter((v) => showVoid || v.status !== 'void')
                    .map((v) => (
                      <tr key={v.id}>
                        <td>
                          v{v.version}
                          {v.changeReason && (
                            <span
                              className="muted"
                              style={{ fontSize: 12, marginLeft: 6 }}
                              {...(v.changeNote ? { title: v.changeNote } : {})}
                            >
                              {CONTRACT_CHANGE_REASON_LABEL[v.changeReason]}
                              {v.changeDetail?.increase &&
                                describeIncrease(v.changeDetail.increase) &&
                                ` · ${describeIncrease(v.changeDetail.increase)}`}
                              {v.resignKinds.length > 0 &&
                                ` · re-sign ${packageLabels(v.resignKinds)}${
                                  v.resignDueOn ? ` by ${fmtDate(v.resignDueOn)}` : ''
                                }`}
                            </span>
                          )}
                        </td>
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
        {versions.some((v) => v.status === 'void') && (
          <button
            type="button"
            className="btn link sm"
            style={{ padding: '8px 0 0' }}
            onClick={() => setShowVoid((s) => !s)}
          >
            {showVoid
              ? 'Hide withdrawn versions'
              : `Show withdrawn versions (${versions.filter((v) => v.status === 'void').length})`}
          </button>
        )}
      </section>

      {wizard && record && (
        <ContractWizard
          worker={worker}
          companyId={companyId}
          record={record}
          draft={wizard.draft}
          latest={versions[0] ?? null}
          onClose={() => setWizard(null)}
          onSaved={load}
          onSend={sendNow}
        />
      )}
    </div>
  );
}
