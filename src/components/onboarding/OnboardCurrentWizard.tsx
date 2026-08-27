'use client';

/**
 * "Onboard Current Contractor" — invites an EXISTING worker (added outside the
 * hire wizard) to the portal. Same shape as the Add Contractor Wizard's later
 * steps, but the identity already exists: pick the contractor, confirm the
 * agreement terms (prefilled from their engagement rows), send the invite.
 * Touches only onboarding artifacts — no worker / link / rate writes.
 */

import { useEffect, useState } from 'react';
import { type Countersigner, Field } from '@/components/contractors/AddContractorWizard';
import { Modal, useToast } from '@/components/ui';
import {
  getOnboardPrefill,
  listOnboardCandidates,
  type OnboardCandidate,
  onboardCurrentContractor,
} from '@/server/actions/contractors';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const checkRow = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  fontSize: 13,
} as const;

interface FormState {
  workerId: string;
  email: string;
  position: string;
  ratePhp: string;
  startDate: string;
  employmentType: '' | 'full_time' | 'part_time';
  hoursPerWeek: string;
  countersignerUserId: string;
  icAddendumType: '' | 'scope_of_work' | 'other';
  icAddendumText: string;
  toolGmail: boolean;
  toolProvidersoft: boolean;
  toolHubstaff: boolean;
  toolZoom: boolean;
  toolOthers: string;
}

const EMPTY: FormState = {
  workerId: '',
  email: '',
  position: '',
  ratePhp: '',
  startDate: '',
  employmentType: '',
  hoursPerWeek: '',
  countersignerUserId: '',
  icAddendumType: '',
  icAddendumText: '',
  toolGmail: false,
  toolProvidersoft: false,
  toolHubstaff: false,
  toolZoom: false,
  toolOthers: '',
};

interface Props {
  companyId: string;
  companyName?: string;
  countersigners: Countersigner[];
  onClose: () => void;
  onCreated: () => void;
}

const STEP_TITLES = ['Contractor', 'Agreement terms & portal'] as const;

export function OnboardCurrentWizard({
  companyId,
  companyName,
  countersigners,
  onClose,
  onCreated,
}: Props) {
  const { notify } = useToast();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [candidates, setCandidates] = useState<OnboardCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [credsEmailSent, setCredsEmailSent] = useState(false);

  useEffect(() => {
    listOnboardCandidates(companyId).then((res) => {
      if (res.ok) setCandidates(res.data);
      else notify(res.error, { type: 'error' });
    });
  }, [companyId, notify]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const pickContractor = (workerId: string) => {
    const c = candidates?.find((x) => x.workerId === workerId);
    setForm((f) => ({ ...f, workerId, email: c?.email ?? f.email }));
    if (!workerId) return;
    // Prefill the agreement terms from the worker's existing engagement rows.
    getOnboardPrefill(workerId).then((res) => {
      if (!res.ok) return;
      const p = res.data;
      setForm((f) =>
        f.workerId === workerId
          ? {
              ...f,
              position: p.position ?? '',
              ratePhp: p.rate ?? '',
              startDate: p.startDate ?? '',
              employmentType: p.employmentType ?? '',
              hoursPerWeek: p.hoursPerWeek != null ? String(p.hoursPerWeek) : '',
            }
          : f,
      );
    });
  };

  const step1Valid = form.workerId !== '' && EMAIL_RE.test(form.email.trim());

  const submit = async () => {
    setBusy(true);
    const res = await onboardCurrentContractor({
      workerId: form.workerId,
      companyId,
      email: form.email.trim(),
      position: form.position.trim() || null,
      ratePhp: form.ratePhp ? Number(form.ratePhp) : 0,
      startDate: form.startDate || null,
      employmentType: form.employmentType || null,
      hoursPerWeek: form.hoursPerWeek ? Number(form.hoursPerWeek) : null,
      countersignerUserId: form.countersignerUserId || null,
      countersignerName:
        countersigners.find((c) => c.userId === form.countersignerUserId)?.name ?? null,
      icAddendumType: form.icAddendumType,
      icAddendumText: form.icAddendumText.trim() || null,
      tools: {
        gmail: form.toolGmail,
        providersoft: form.toolProvidersoft,
        hubstaff: form.toolHubstaff,
        zoom: form.toolZoom,
        others: form.toolOthers.trim(),
      },
    });
    setBusy(false);
    if (!res.ok) {
      notify(res.error, { type: 'error' });
      return;
    }
    if (res.data.tempPassword) {
      setTempPassword(res.data.tempPassword);
      setCredsEmailSent(res.data.emailSent ?? false);
    } else {
      notify('Portal invite sent.', { type: 'success' });
      onCreated();
      onClose();
    }
  };

  const finishClose = () => {
    onCreated();
    onClose();
  };

  if (tempPassword) {
    return (
      <Modal title="Contractor invited" onClose={finishClose} maxWidth={460}>
        <p className="sub">
          {credsEmailSent
            ? 'Their portal login was created and the credentials were emailed to them — they’ll set their own password on first sign-in. Backup copy:'
            : 'Their portal login was created but the credentials email could NOT be sent — share this temporary password yourself (they’ll set their own on first sign-in).'}
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

  const selected = candidates?.find((c) => c.workerId === form.workerId);

  return (
    <Modal onClose={onClose} maxWidth={560}>
      <div className="card-head">
        <h2>
          Onboard current contractor{' '}
          <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>
            · {companyName || 'this company'}
          </span>
        </h2>
        <button type="button" className="btn ghost sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, margin: '10px 0' }}>
        {[1, 2].map((n) => (
          <div
            key={n}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: n <= step ? 'var(--navy)' : '#e5e7eb',
            }}
          />
        ))}
      </div>
      <p className="sub" style={{ marginTop: 0 }}>
        Step {step} of 2 · {STEP_TITLES[step - 1]}
      </p>

      {step === 1 && (
        <div>
          <p className="sub">
            Invite a contractor who was added without the hire wizard. Their agreement terms are
            prefilled from what’s already on file — you’ll confirm them next.
          </p>
          <Field label="Contractor *">
            <select
              value={form.workerId}
              disabled={candidates === null}
              onChange={(e) => pickContractor(e.target.value)}
            >
              <option value="">
                {candidates === null
                  ? 'Loading…'
                  : candidates.length === 0
                    ? 'No contractors awaiting onboarding'
                    : 'Select…'}
              </option>
              {(candidates ?? []).map((c) => (
                <option key={c.workerId} value={c.workerId}>
                  {c.name}
                  {c.email ? ` — ${c.email}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Personal email *">
            <input
              type="email"
              value={form.email}
              placeholder="name@example.com"
              onChange={(e) => set('email', e.target.value)}
            />
          </Field>
        </div>
      )}

      {step === 2 && (
        <div>
          <Field label="Role / position">
            <input value={form.position} onChange={(e) => set('position', e.target.value)} />
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
          <Field label="Start date">
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => set('startDate', e.target.value)}
            />
          </Field>
          <Field label="Engagement">
            <select
              value={form.employmentType}
              onChange={(e) => set('employmentType', e.target.value as FormState['employmentType'])}
            >
              <option value="">— Not stated —</option>
              <option value="full_time">Full-time</option>
              <option value="part_time">Part-time</option>
            </select>
          </Field>
          <Field label="Expected hours / week">
            <input
              type="number"
              min="0"
              max="168"
              value={form.hoursPerWeek}
              onChange={(e) => set('hoursPerWeek', e.target.value)}
            />
          </Field>
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
              aria-label="IC addendum text"
              placeholder="Addendum text"
              onChange={(e) => set('icAddendumText', e.target.value)}
              style={{ width: '100%', marginTop: 6 }}
            />
          )}

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
            <strong>{selected?.name ?? '(no contractor)'}</strong>
            <p className="sub" style={{ margin: '4px 0 0' }}>
              {form.position || '(no role)'} ·{' '}
              {form.ratePhp ? `₱${form.ratePhp}/period` : 'no rate'} · invite to {form.email}
            </p>
          </div>
        </div>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 16,
          gap: 8,
        }}
      >
        <button
          type="button"
          className="btn ghost"
          onClick={() => setStep(1)}
          disabled={busy || step === 1}
        >
          Back
        </button>
        {step === 1 ? (
          <button type="button" className="btn" disabled={!step1Valid} onClick={() => setStep(2)}>
            Next
          </button>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={submit}>
            {busy ? 'Inviting…' : 'Create login & send invite'}
          </button>
        )}
      </div>
    </Modal>
  );
}
