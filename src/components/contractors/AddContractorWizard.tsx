'use client';

import { ConfirmDangerModal, Modal, useToast } from '@/components/ui';
import { hireContractor } from '@/server/actions/contractors';
import { type ReactNode, useState } from 'react';
import { type HireDraft, draftClear, draftLoad, useAutoDraft } from './hire-draft';

export interface Countersigner {
  userId: string;
  name: string;
}

interface FormState {
  firstName: string;
  middleName: string;
  lastName: string;
  email: string;
  phAddress: string;
  permanentAddress: string;
  sameAsCurrent: boolean;
  dateOfBirth: string;
  contract: 'FT' | 'PT';
  weeklyHours: string;
  role: string;
  ratePhp: string;
  contractDate: string;
  hireDate: string;
  healthAllowanceEligible: boolean;
  thirteenthMonthEligible: boolean;
  shiftStart: string;
  shiftEnd: string;
  countersignerUserId: string;
  icAddendumType: '' | 'scope_of_work' | 'other';
  icAddendumText: string;
  invite: boolean;
  toolGmail: boolean;
  toolProvidersoft: boolean;
  toolHubstaff: boolean;
  toolZoom: boolean;
  toolOthers: string;
}

const EMPTY: FormState = {
  firstName: '',
  middleName: '',
  lastName: '',
  email: '',
  phAddress: '',
  permanentAddress: '',
  sameAsCurrent: false,
  dateOfBirth: '',
  contract: 'FT',
  weeklyHours: '40',
  role: '',
  ratePhp: '',
  contractDate: '',
  hireDate: '',
  healthAllowanceEligible: true,
  thirteenthMonthEligible: true,
  shiftStart: '',
  shiftEnd: '',
  countersignerUserId: '',
  icAddendumType: '',
  icAddendumText: '',
  invite: true,
  toolGmail: false,
  toolProvidersoft: false,
  toolHubstaff: false,
  toolZoom: false,
  toolOthers: '',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const checkRow = { display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 } as const;

/** Block caption + nested control (the nesting associates the label, a11y-clean). */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children and nested in this label
    <label style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
      {label}
      {children}
    </label>
  );
}

interface Props {
  companyId: string;
  companyName?: string;
  countersigners: Countersigner[];
  onClose: () => void;
  onCreated: () => void;
}

const STEP_TITLES = ['Identity', 'Engagement (IC terms)', 'Portal & onboarding'] as const;

export function AddContractorWizard({
  companyId,
  companyName,
  countersigners,
  onClose,
  onCreated,
}: Props) {
  const { notify } = useToast();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormState>(() => {
    const d = draftLoad<FormState>(companyId);
    return d?.f ?? EMPTY;
  });
  const [resumed] = useState(() => draftLoad<FormState>(companyId) !== null);
  const [busy, setBusy] = useState(false);
  const [dupConfirm, setDupConfirm] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const hasContent =
    form.firstName.trim() !== '' || form.lastName.trim() !== '' || form.role.trim() !== '';
  const draft: HireDraft<FormState> = { f: form, step, at: 0 };
  const { markDone } = useAutoDraft(companyId, draft, hasContent && !done);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const step1Valid =
    form.firstName.trim() !== '' &&
    form.lastName.trim() !== '' &&
    (!form.invite || EMAIL_RE.test(form.email.trim()));
  const step2Valid = form.role.trim() !== '' && form.hireDate !== '';

  const payload = (allowDuplicateName: boolean) => ({
    companyId,
    firstName: form.firstName.trim(),
    middleName: form.middleName.trim() || null,
    lastName: form.lastName.trim(),
    email: form.email.trim() || null,
    phAddress: form.phAddress.trim() || null,
    permanentAddress: (form.sameAsCurrent ? form.phAddress : form.permanentAddress).trim() || null,
    dateOfBirth: form.dateOfBirth || null,
    contract: form.contract,
    weeklyHours: form.weeklyHours ? Number(form.weeklyHours) : null,
    role: form.role.trim(),
    ratePhp: form.ratePhp ? Number(form.ratePhp) : 0,
    contractDate: form.contractDate || null,
    hireDate: form.hireDate,
    healthAllowanceEligible: form.healthAllowanceEligible,
    thirteenthMonthEligible: form.thirteenthMonthEligible,
    shiftStart: form.shiftStart || null,
    shiftEnd: form.shiftEnd || null,
    shiftLabel: null,
    countersignerUserId: form.countersignerUserId || null,
    countersignerName:
      countersigners.find((c) => c.userId === form.countersignerUserId)?.name ?? null,
    icAddendumType: form.icAddendumType,
    icAddendumText: form.icAddendumText.trim() || null,
    extraDocs: [],
    invite: form.invite,
    tools: {
      gmail: form.toolGmail,
      providersoft: form.toolProvidersoft,
      hubstaff: form.toolHubstaff,
      zoom: form.toolZoom,
      others: form.toolOthers.trim(),
    },
    allowDuplicateName,
  });

  const create = async (allowDuplicateName: boolean) => {
    setBusy(true);
    const res = await hireContractor(payload(allowDuplicateName));
    setBusy(false);
    if (!res.ok) {
      if (res.error.startsWith('DUPLICATE_NAME:')) {
        setDupConfirm(res.error.replace('DUPLICATE_NAME:', '').trim());
        return;
      }
      notify(res.error, { type: 'error' });
      return;
    }
    markDone();
    draftClear(companyId);
    setDone(true);
    if (res.data.tempPassword) setTempPassword(res.data.tempPassword);
    else {
      notify('Contractor created.', { type: 'success' });
      onCreated();
      onClose();
    }
  };

  const finishClose = () => {
    onCreated();
    onClose();
  };

  if (done && tempPassword) {
    return (
      <Modal title="Contractor created" onClose={finishClose} maxWidth={460}>
        <p className="sub">
          Their portal login was created. Share this temporary password — they&apos;ll set their own
          on first sign-in.
        </p>
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            margin: '12px 0',
            padding: '8px 12px',
            background: 'var(--surface2)',
            borderRadius: 6,
          }}
        >
          <code style={{ fontSize: 15, flex: 1 }}>{tempPassword}</code>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              navigator.clipboard?.writeText(tempPassword);
              notify('Copied.', { type: 'success' });
            }}
          >
            Copy
          </button>
        </div>
        <button type="button" className="btn" onClick={finishClose}>
          Done
        </button>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} maxWidth={560}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>
          Add contractor{' '}
          <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>
            · {companyName || 'this company'}
          </span>
        </h2>
        <button type="button" className="btn ghost sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, margin: '10px 0' }}>
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: n <= step ? '#1F3A68' : '#e5e7eb',
            }}
          />
        ))}
      </div>
      <p className="sub" style={{ marginTop: 0 }}>
        Step {step} of 3 · {STEP_TITLES[step - 1]}
      </p>

      {resumed && step === 1 && (
        <div className="banner" style={{ marginBottom: 10 }}>
          ↩ Resumed your saved draft.{' '}
          <button
            type="button"
            className="btn link"
            onClick={() => {
              draftClear(companyId);
              setForm(EMPTY);
            }}
          >
            Start fresh
          </button>
        </div>
      )}

      {step === 1 && (
        <div>
          <Field label="First name *">
            <input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
          </Field>
          <Field label="Middle name">
            <input value={form.middleName} onChange={(e) => set('middleName', e.target.value)} />
          </Field>
          <Field label="Last name *">
            <input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
          </Field>
          <Field label={`Personal email${form.invite ? ' *' : ''}`}>
            <input
              type="email"
              value={form.email}
              placeholder="name@example.com"
              onChange={(e) => set('email', e.target.value)}
            />
          </Field>
          <Field label="Current address">
            <input value={form.phAddress} onChange={(e) => set('phAddress', e.target.value)} />
          </Field>
          <div style={{ margin: '6px 0' }}>
            <label
              className="muted"
              style={{ fontSize: 12, display: 'block', marginBottom: 2 }}
              htmlFor="acw-perm-addr"
            >
              Permanent address
            </label>
            <label className="muted" style={{ ...checkRow, margin: '2px 0 4px' }}>
              <input
                type="checkbox"
                checked={form.sameAsCurrent}
                onChange={(e) => set('sameAsCurrent', e.target.checked)}
              />
              Same as current address
            </label>
            <input
              id="acw-perm-addr"
              value={form.permanentAddress}
              disabled={form.sameAsCurrent}
              onChange={(e) => set('permanentAddress', e.target.value)}
            />
          </div>
          <Field label="Date of birth">
            <input
              type="date"
              value={form.dateOfBirth}
              onChange={(e) => set('dateOfBirth', e.target.value)}
            />
          </Field>
        </div>
      )}

      {step === 2 && (
        <div>
          <Field label="Contract *">
            <select
              value={form.contract}
              onChange={(e) => {
                const c = e.target.value as 'FT' | 'PT';
                setForm((f) => ({ ...f, contract: c, weeklyHours: c === 'FT' ? '40' : '20' }));
              }}
            >
              <option value="FT">Full-time</option>
              <option value="PT">Part-time</option>
            </select>
          </Field>
          <Field label="Expected hours / week">
            <input
              type="number"
              min="0"
              max="168"
              value={form.weeklyHours}
              onChange={(e) => set('weeklyHours', e.target.value)}
            />
          </Field>
          <Field label="Role / position *">
            <input value={form.role} onChange={(e) => set('role', e.target.value)} />
          </Field>
          <Field label="Rate (PHP per period)">
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.ratePhp}
              onChange={(e) => set('ratePhp', e.target.value)}
            />
          </Field>
          <Field label="Hire date *">
            <input
              type="date"
              value={form.hireDate}
              onChange={(e) => set('hireDate', e.target.value)}
            />
          </Field>
          <Field label="Contract date">
            <input
              type="date"
              value={form.contractDate}
              onChange={(e) => set('contractDate', e.target.value)}
            />
          </Field>
          <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
            <label style={checkRow}>
              <input
                type="checkbox"
                checked={form.healthAllowanceEligible}
                onChange={(e) => set('healthAllowanceEligible', e.target.checked)}
              />
              Health allowance
            </label>
            <label style={checkRow}>
              <input
                type="checkbox"
                checked={form.thirteenthMonthEligible}
                onChange={(e) => set('thirteenthMonthEligible', e.target.checked)}
              />
              13th month
            </label>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Field label="Shift start (PHT)">
                <input
                  type="time"
                  value={form.shiftStart}
                  onChange={(e) => set('shiftStart', e.target.value)}
                />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Shift end (PHT)">
                <input
                  type="time"
                  value={form.shiftEnd}
                  onChange={(e) => set('shiftEnd', e.target.value)}
                />
              </Field>
            </div>
          </div>
          <Field label="Company countersigner">
            <select
              value={form.countersignerUserId}
              onChange={(e) => set('countersignerUserId', e.target.value)}
            >
              <option value="">— None —</option>
              {countersigners.map((c) => (
                <option key={c.userId} value={c.userId}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="IC addendum">
            <select
              value={form.icAddendumType}
              onChange={(e) => set('icAddendumType', e.target.value as FormState['icAddendumType'])}
            >
              <option value="">No addendum</option>
              <option value="scope_of_work">Scope of work</option>
              <option value="other">Other</option>
            </select>
          </Field>
          {form.icAddendumType !== '' && (
            <textarea
              rows={3}
              value={form.icAddendumText}
              placeholder="Addendum text"
              onChange={(e) => set('icAddendumText', e.target.value)}
              style={{ width: '100%', marginTop: 6 }}
            />
          )}
        </div>
      )}

      {step === 3 && (
        <div>
          <label style={{ ...checkRow, marginTop: 8 }}>
            <input
              type="checkbox"
              checked={form.invite}
              onChange={(e) => set('invite', e.target.checked)}
            />
            Invite to the contractor portal
          </label>
          <p className="sub" style={{ marginTop: 12 }}>
            Tools to provision (logins entered later at onboarding completion):
          </p>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {(
              [
                ['toolGmail', 'Gmail'],
                ['toolProvidersoft', 'Providersoft'],
                ['toolHubstaff', 'Hubstaff'],
                ['toolZoom', 'Zoom'],
              ] as const
            ).map(([k, label]) => (
              <label key={k} style={checkRow}>
                <input
                  type="checkbox"
                  checked={form[k]}
                  onChange={(e) => set(k, e.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>
          <Field label="Other tools">
            <input value={form.toolOthers} onChange={(e) => set('toolOthers', e.target.value)} />
          </Field>
          <div className="card" style={{ marginTop: 12, background: 'var(--surface2)' }}>
            <strong>
              {[form.firstName, form.lastName].filter(Boolean).join(' ') || '(no name)'}
            </strong>
            <p className="sub" style={{ margin: '4px 0 0' }}>
              {form.contract} · {form.role || '(no role)'} ·{' '}
              {form.ratePhp ? `₱${form.ratePhp}/period` : 'no rate'} ·{' '}
              {form.invite ? 'portal invite' : 'no invite'}
            </p>
          </div>
        </div>
      )}

      <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
        ✓ Progress auto-saved on this device — you can close and pick up where you left off.
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, gap: 8 }}>
        <button
          type="button"
          className="btn ghost"
          onClick={() => setStep(step - 1)}
          disabled={busy || step === 1}
        >
          Back
        </button>
        {step < 3 ? (
          <button
            type="button"
            className="btn"
            disabled={(step === 1 && !step1Valid) || (step === 2 && !step2Valid)}
            onClick={() => setStep(step + 1)}
          >
            Next
          </button>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={() => create(false)}>
            {busy ? 'Creating…' : 'Create contractor'}
          </button>
        )}
      </div>

      {dupConfirm && (
        <ConfirmDangerModal
          title="Possible duplicate"
          message={dupConfirm}
          consequence="Create anyway only if this is a genuinely different person."
          confirmWord="DUPLICATE"
          confirmLabel="Create anyway"
          busy={busy}
          onConfirm={() => {
            setDupConfirm(null);
            void create(true);
          }}
          onCancel={() => setDupConfirm(null)}
        />
      )}
    </Modal>
  );
}
