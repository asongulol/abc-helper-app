import type { RosterWorker } from '@/db/queries/workers';
import type { WorkerEngagement } from '@/server/actions/contractors';
import { PAY_BASIS_OPTIONS, type PayBasis } from '@/types/schemas/contractors';
import { RateCard } from '../RateCard';
import { Field } from './Field';
import { SaveBar } from './SaveBar';
import { type ProfileTabProps, SECTION_H4 } from './types';

interface Props extends ProfileTabProps {
  worker: RosterWorker;
  companyId: string;
  companyName?: string | undefined;
  companies: { id: string; name: string }[];
  engagements: WorkerEngagement[];
  updateEng: (i: number, patch: Partial<WorkerEngagement>) => void;
  saveEng: (e: WorkerEngagement) => void;
  assignTo: string;
  setAssignTo: (v: string) => void;
  handleAssign: () => void;
}

/** Pay & payout tab — per-company engagement, PHP rate card, and client engagements. */
export function PayTab({
  worker,
  companyId,
  companyName,
  companies,
  engagements,
  updateEng,
  saveEng,
  assignTo,
  setAssignTo,
  handleAssign,
  form,
  set,
  errors,
  isPending,
  serverError,
  onSubmit,
  panelProps,
}: Props) {
  return (
    <div {...panelProps}>
      {/* Only the per-company engagement saves via the profile form; the rate
          card and client-engagement rows below have their own controls, so they
          sit outside it — a <form> cannot legally nest the RateCard's <form>. */}
      <form onSubmit={onSubmit} noValidate>
        <section>
          <h4 style={SECTION_H4}>Per-company engagement{companyName ? ` · ${companyName}` : ''}</h4>
          <div className="grid-2">
            <Field id="pp-position" label="Position">
              <input
                id="pp-position"
                value={form.role}
                onChange={(e) => set('role', e.target.value)}
                placeholder="e.g. Billing Specialist"
                disabled={isPending}
              />
            </Field>
            <Field id="pp-bill" label="Bill rate (USD/hr)" error={errors.billRateUsd}>
              <input
                id="pp-bill"
                type="number"
                min="0"
                step="0.01"
                value={form.billRateUsd}
                onChange={(e) => set('billRateUsd', e.target.value)}
                placeholder="—"
                disabled={isPending}
              />
            </Field>
            <Field id="pp-session" label="Session rate (USD/visit)" error={errors.sessionRateUsd}>
              <input
                id="pp-session"
                type="number"
                min="0"
                step="0.01"
                value={form.sessionRateUsd}
                onChange={(e) => set('sessionRateUsd', e.target.value)}
                placeholder="—"
                disabled={isPending}
              />
            </Field>
            <Field id="pp-link-status" label="Assignment status">
              <select
                id="pp-link-status"
                value={form.linkStatus}
                onChange={(e) =>
                  set('linkStatus', e.target.value as 'active' | 'inactive' | 'ended')
                }
                disabled={isPending}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="ended">Ended</option>
              </select>
            </Field>
          </div>
        </section>
        <section style={{ marginTop: 24 }}>
          <h4 style={SECTION_H4}>Wise payout</h4>
          <p className="sub" style={{ margin: '-4px 0 12px' }}>
            The Wise recipient identifies who gets paid by the Wise API draft. Set the recipient up
            in Wise (use the contractor&apos;s Wise Tag on Personal / HR), then store the IDs here.
          </p>
          <div className="grid-2">
            <Field id="pp-wise-rid" label="Wise recipient ID" error={errors.wiseRecipientId}>
              <input
                id="pp-wise-rid"
                inputMode="numeric"
                value={form.wiseRecipientId}
                onChange={(e) => set('wiseRecipientId', e.target.value)}
                placeholder="—"
                disabled={isPending}
              />
            </Field>
            <Field id="pp-wise-uuid" label="Wise recipient UUID (for manual Batch CSV)">
              <input
                id="pp-wise-uuid"
                value={form.wiseRecipientUuid}
                onChange={(e) => set('wiseRecipientUuid', e.target.value)}
                placeholder="—"
                disabled={isPending}
              />
            </Field>
          </div>
        </section>
        <SaveBar isPending={isPending} serverError={serverError} />
      </form>
      <section style={{ marginTop: 24 }}>
        <h4 style={SECTION_H4}>Pay rate (PHP, semi-monthly)</h4>
        <RateCard workerId={worker.workerId} companyId={companyId} />
      </section>
      <section style={{ marginTop: 24 }}>
        <h4 style={SECTION_H4}>Client engagements</h4>
        {engagements.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            No company engagements yet.
          </p>
        ) : (
          engagements.map((e, i) => (
            <div
              key={e.companyId}
              className="row"
              style={{
                alignItems: 'flex-end',
                flexWrap: 'wrap',
                gap: 8,
                paddingTop: 8,
                borderTop: '1px solid var(--border)',
              }}
            >
              <div style={{ flex: '1 1 140px', minWidth: 0 }}>
                <strong style={{ fontSize: 13 }}>{e.companyName}</strong>
                {e.kind === 'employer' && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    {' '}
                    · employer
                  </span>
                )}
              </div>
              <Field id={`eng-pos-${e.companyId}`} label="Position">
                <input
                  id={`eng-pos-${e.companyId}`}
                  value={e.role ?? ''}
                  onChange={(ev) => updateEng(i, { role: ev.target.value || null })}
                  disabled={isPending}
                />
              </Field>
              <Field id={`eng-rate-${e.companyId}`} label="Bill rate (USD/hr)">
                <input
                  id={`eng-rate-${e.companyId}`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={e.billRateUsd ?? ''}
                  onChange={(ev) =>
                    updateEng(i, {
                      billRateUsd: ev.target.value === '' ? null : Number(ev.target.value),
                    })
                  }
                  disabled={isPending}
                />
              </Field>
              <Field id={`eng-srate-${e.companyId}`} label="Session rate (USD/visit)">
                <input
                  id={`eng-srate-${e.companyId}`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={e.sessionRateUsd ?? ''}
                  onChange={(ev) =>
                    updateEng(i, {
                      sessionRateUsd: ev.target.value === '' ? null : Number(ev.target.value),
                    })
                  }
                  disabled={isPending}
                />
              </Field>
              {e.contract === 'PHS' && (
                <Field id={`eng-basis-${e.companyId}`} label="Pay basis">
                  <select
                    id={`eng-basis-${e.companyId}`}
                    value={e.payBasis ?? ''}
                    onChange={(ev) =>
                      updateEng(i, { payBasis: (ev.target.value || null) as PayBasis | null })
                    }
                    disabled={isPending}
                  >
                    <option value="">Select…</option>
                    {PAY_BASIS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field id={`eng-status-${e.companyId}`} label="Status">
                <select
                  id={`eng-status-${e.companyId}`}
                  value={e.status}
                  onChange={(ev) => updateEng(i, { status: ev.target.value })}
                  disabled={isPending}
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="ended">Ended</option>
                </select>
              </Field>
              <button
                type="button"
                className="btn ghost sm"
                disabled={isPending}
                onClick={() => saveEng(e)}
              >
                Save
              </button>
            </div>
          ))
        )}
        {companies.length > 0 && (
          <div className="row" style={{ marginTop: 12, alignItems: 'flex-end', gap: 8 }}>
            <Field id="eng-assign" label="Assign to company">
              <select
                id="eng-assign"
                value={assignTo}
                onChange={(ev) => setAssignTo(ev.target.value)}
                disabled={isPending}
              >
                <option value="">— select —</option>
                {companies
                  .filter((c) => !engagements.some((e) => e.companyId === c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </Field>
            <button
              type="button"
              className="btn sm"
              disabled={isPending || !assignTo}
              onClick={handleAssign}
            >
              Add company
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
