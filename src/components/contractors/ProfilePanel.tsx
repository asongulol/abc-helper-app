'use client';

import { Modal, Spinner } from '@/components/ui';
import type { RosterWorker } from '@/db/queries/workers';
import { saveWorkerProfile } from '@/server/actions/contractors';
import { type FormEvent, type ReactNode, useState, useTransition } from 'react';
import { RateCard } from './RateCard';

type Props = {
  worker: RosterWorker;
  companyId: string;
  onClose: () => void;
  onSaved: (updated: RosterWorker) => void;
};

type FormState = {
  firstName: string;
  middleName: string;
  lastName: string;
  email: string;
  mobile: string;
  hireDate: string;
  phAddress: string;
  permanentAddress: string;
  addressLandmark: string;
  postalCode: string;
  payoutMethod: string;
  healthAllowanceEligible: boolean;
  thirteenthMonthEligible: boolean;
  contract: 'FT' | 'PT';
  role: string;
  hubstaffName: string;
  weeklyHours: string;
  linkStatus: 'active' | 'inactive' | 'ended';
};

function toForm(w: RosterWorker): FormState {
  return {
    firstName: w.firstName,
    middleName: w.middleName ?? '',
    lastName: w.lastName,
    email: w.email ?? '',
    mobile: w.mobile ?? '',
    hireDate: w.hireDate ?? '',
    phAddress: w.phAddress ?? '',
    permanentAddress: w.permanentAddress ?? '',
    addressLandmark: w.addressLandmark ?? '',
    postalCode: w.postalCode ?? '',
    payoutMethod: w.payoutMethod ?? '',
    healthAllowanceEligible: w.healthAllowanceEligible,
    thirteenthMonthEligible: w.thirteenthMonthEligible,
    contract: w.contract,
    role: w.role ?? '',
    hubstaffName: w.hubstaffName ?? '',
    weeklyHours: w.weeklyHours != null ? String(w.weeklyHours) : '',
    linkStatus:
      w.linkStatus === 'ended' ? 'ended' : w.linkStatus === 'inactive' ? 'inactive' : 'active',
  };
}

type ValidPayoutMethod = 'wise' | 'bpi' | 'gcash' | 'paymaya' | 'paypal';
type ValidWorkerStatus = 'active' | 'inactive' | 'ended';

export function ProfilePanel({ worker, companyId, onClose, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(() => toForm(worker));
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [serverError, setServerError] = useState('');
  const [isPending, startTransition] = useTransition();
  const [activeTab, setActiveTab] = useState<'profile' | 'rate'>('profile');

  const fullName = [worker.firstName, worker.middleName, worker.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function validate(): boolean {
    const errs: Partial<Record<keyof FormState, string>> = {};
    if (!form.firstName.trim()) errs.firstName = 'Required.';
    if (!form.lastName.trim()) errs.lastName = 'Required.';
    if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) {
      errs.email = 'Invalid email.';
    }
    if (form.hireDate && !/^\d{4}-\d{2}-\d{2}$/.test(form.hireDate)) {
      errs.hireDate = 'Must be YYYY-MM-DD.';
    }
    if (form.weeklyHours !== '' && Number.isNaN(Number(form.weeklyHours))) {
      errs.weeklyHours = 'Must be a number.';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setServerError('');

    const PAYOUT_METHODS: ValidPayoutMethod[] = ['wise', 'bpi', 'gcash', 'paymaya', 'paypal'];
    const payoutMethod: ValidPayoutMethod | null = PAYOUT_METHODS.includes(
      form.payoutMethod as ValidPayoutMethod,
    )
      ? (form.payoutMethod as ValidPayoutMethod)
      : null;

    const LINK_STATUSES: ValidWorkerStatus[] = ['active', 'inactive', 'ended'];
    const linkStatus: ValidWorkerStatus = LINK_STATUSES.includes(
      form.linkStatus as ValidWorkerStatus,
    )
      ? (form.linkStatus as ValidWorkerStatus)
      : 'active';

    startTransition(async () => {
      const result = await saveWorkerProfile({
        workerId: worker.workerId,
        companyId,
        firstName: form.firstName.trim(),
        middleName: form.middleName.trim() || null,
        lastName: form.lastName.trim(),
        email: form.email.trim() || null,
        mobile: form.mobile.trim() || null,
        hireDate: form.hireDate || null,
        phAddress: form.phAddress.trim() || null,
        permanentAddress: form.permanentAddress.trim() || null,
        addressLandmark: form.addressLandmark.trim() || null,
        postalCode: form.postalCode.trim() || null,
        payoutMethod,
        healthAllowanceEligible: form.healthAllowanceEligible,
        thirteenthMonthEligible: form.thirteenthMonthEligible,
        contract: form.contract,
        role: form.role.trim() || null,
        hubstaffName: form.hubstaffName.trim() || null,
        weeklyHours: form.weeklyHours !== '' ? Number(form.weeklyHours) : null,
        linkStatus,
      });
      if (!result.ok) {
        setServerError(result.error);
        return;
      }
      const updated: RosterWorker = {
        ...worker,
        firstName: form.firstName.trim(),
        middleName: form.middleName.trim() || null,
        lastName: form.lastName.trim(),
        email: form.email.trim() || null,
        mobile: form.mobile.trim() || null,
        hireDate: form.hireDate || null,
        phAddress: form.phAddress.trim() || null,
        permanentAddress: form.permanentAddress.trim() || null,
        addressLandmark: form.addressLandmark.trim() || null,
        postalCode: form.postalCode.trim() || null,
        payoutMethod,
        healthAllowanceEligible: form.healthAllowanceEligible,
        thirteenthMonthEligible: form.thirteenthMonthEligible,
        contract: form.contract,
        role: form.role.trim() || null,
        hubstaffName: form.hubstaffName.trim() || null,
        weeklyHours: form.weeklyHours !== '' ? Number(form.weeklyHours) : null,
        linkStatus,
        workerStatus: linkStatus === 'active' ? 'active' : linkStatus,
      };
      onSaved(updated);
    });
  }

  return (
    <Modal title={fullName || 'New contractor'} onClose={onClose} maxWidth={680}>
      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          marginBottom: 16,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <button
          type="button"
          className={activeTab === 'profile' ? 'btn sm' : 'btn ghost sm'}
          style={{ borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0' }}
          onClick={() => setActiveTab('profile')}
        >
          Profile
        </button>
        <button
          type="button"
          className={activeTab === 'rate' ? 'btn sm' : 'btn ghost sm'}
          style={{ borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0' }}
          onClick={() => setActiveTab('rate')}
        >
          Rate
        </button>
      </div>

      {activeTab === 'profile' && (
        <form onSubmit={handleSave} noValidate>
          <section>
            <h4
              style={{
                margin: '0 0 12px',
                fontSize: 13,
                textTransform: 'uppercase',
                letterSpacing: '.05em',
                color: 'var(--muted)',
              }}
            >
              Personal
            </h4>
            <div className="grid-2">
              <Field id="pp-first" label="First name" required error={errors.firstName}>
                <input
                  id="pp-first"
                  value={form.firstName}
                  onChange={(e) => set('firstName', e.target.value)}
                  aria-invalid={errors.firstName ? 'true' : undefined}
                  disabled={isPending}
                />
              </Field>
              <Field id="pp-middle" label="Middle name">
                <input
                  id="pp-middle"
                  value={form.middleName}
                  onChange={(e) => set('middleName', e.target.value)}
                  disabled={isPending}
                />
              </Field>
              <Field id="pp-last" label="Last name" required error={errors.lastName}>
                <input
                  id="pp-last"
                  value={form.lastName}
                  onChange={(e) => set('lastName', e.target.value)}
                  aria-invalid={errors.lastName ? 'true' : undefined}
                  disabled={isPending}
                />
              </Field>
              <Field id="pp-email" label="Email" error={errors.email}>
                <input
                  id="pp-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => set('email', e.target.value)}
                  aria-invalid={errors.email ? 'true' : undefined}
                  disabled={isPending}
                />
              </Field>
              <Field id="pp-mobile" label="Mobile">
                <input
                  id="pp-mobile"
                  value={form.mobile}
                  onChange={(e) => set('mobile', e.target.value)}
                  disabled={isPending}
                />
              </Field>
              <Field id="pp-hire" label="Hire date" error={errors.hireDate}>
                <input
                  id="pp-hire"
                  type="date"
                  value={form.hireDate}
                  onChange={(e) => set('hireDate', e.target.value)}
                  aria-invalid={errors.hireDate ? 'true' : undefined}
                  disabled={isPending}
                />
              </Field>
            </div>
          </section>

          <section style={{ marginTop: 20 }}>
            <h4
              style={{
                margin: '0 0 12px',
                fontSize: 13,
                textTransform: 'uppercase',
                letterSpacing: '.05em',
                color: 'var(--muted)',
              }}
            >
              Addresses
            </h4>
            <div className="field">
              <label htmlFor="pp-ph-addr">PH address</label>
              <input
                id="pp-ph-addr"
                value={form.phAddress}
                onChange={(e) => set('phAddress', e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="field">
              <label htmlFor="pp-perm-addr">Permanent address</label>
              <input
                id="pp-perm-addr"
                value={form.permanentAddress}
                onChange={(e) => set('permanentAddress', e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="pp-landmark">Landmark</label>
                <input
                  id="pp-landmark"
                  value={form.addressLandmark}
                  onChange={(e) => set('addressLandmark', e.target.value)}
                  disabled={isPending}
                />
              </div>
              <div className="field">
                <label htmlFor="pp-postal">Postal code</label>
                <input
                  id="pp-postal"
                  value={form.postalCode}
                  onChange={(e) => set('postalCode', e.target.value)}
                  disabled={isPending}
                />
              </div>
            </div>
          </section>

          <section style={{ marginTop: 20 }}>
            <h4
              style={{
                margin: '0 0 12px',
                fontSize: 13,
                textTransform: 'uppercase',
                letterSpacing: '.05em',
                color: 'var(--muted)',
              }}
            >
              Payroll eligibility
            </h4>
            <div style={{ display: 'flex', gap: 24 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={form.healthAllowanceEligible}
                  onChange={(e) => set('healthAllowanceEligible', e.target.checked)}
                  disabled={isPending}
                />
                Health allowance eligible
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={form.thirteenthMonthEligible}
                  onChange={(e) => set('thirteenthMonthEligible', e.target.checked)}
                  disabled={isPending}
                />
                13th month eligible
              </label>
            </div>
          </section>

          <section style={{ marginTop: 20 }}>
            <h4
              style={{
                margin: '0 0 12px',
                fontSize: 13,
                textTransform: 'uppercase',
                letterSpacing: '.05em',
                color: 'var(--muted)',
              }}
            >
              Payout
            </h4>
            <div className="field" style={{ maxWidth: 220 }}>
              <label htmlFor="pp-payout">Payout method</label>
              <select
                id="pp-payout"
                value={form.payoutMethod}
                onChange={(e) => set('payoutMethod', e.target.value)}
                disabled={isPending}
              >
                <option value="">— not set —</option>
                <option value="wise">Wise</option>
                <option value="bpi">BPI</option>
                <option value="gcash">GCash</option>
                <option value="paymaya">PayMaya</option>
                <option value="paypal">PayPal</option>
              </select>
            </div>
          </section>

          <section style={{ marginTop: 20 }}>
            <h4
              style={{
                margin: '0 0 12px',
                fontSize: 13,
                textTransform: 'uppercase',
                letterSpacing: '.05em',
                color: 'var(--muted)',
              }}
            >
              Engagement
            </h4>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="pp-contract">Contract</label>
                <select
                  id="pp-contract"
                  value={form.contract}
                  onChange={(e) => set('contract', e.target.value as 'FT' | 'PT')}
                  disabled={isPending}
                >
                  <option value="FT">Full-time (FT)</option>
                  <option value="PT">Part-time (PT)</option>
                </select>
              </div>
              <Field id="pp-role" label="Role">
                <input
                  id="pp-role"
                  value={form.role}
                  onChange={(e) => set('role', e.target.value)}
                  placeholder="e.g. Speech Therapist"
                  disabled={isPending}
                />
              </Field>
              <Field id="pp-hubstaff" label="Hubstaff name">
                <input
                  id="pp-hubstaff"
                  value={form.hubstaffName}
                  onChange={(e) => set('hubstaffName', e.target.value)}
                  disabled={isPending}
                />
              </Field>
              <Field id="pp-hours" label="Weekly hours" error={errors.weeklyHours}>
                <input
                  id="pp-hours"
                  type="number"
                  min="0"
                  max="168"
                  step="0.5"
                  value={form.weeklyHours}
                  onChange={(e) => set('weeklyHours', e.target.value)}
                  aria-invalid={errors.weeklyHours ? 'true' : undefined}
                  disabled={isPending}
                />
              </Field>
              <div className="field">
                <label htmlFor="pp-link-status">Link status</label>
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
              </div>
            </div>
          </section>

          {serverError && (
            <div
              className="banner"
              style={{
                marginTop: 14,
                borderColor: 'var(--bad)',
                background: 'var(--bad-soft)',
                color: 'var(--bad)',
              }}
            >
              {serverError}
            </div>
          )}

          <div className="actions" style={{ marginTop: 20 }}>
            <button type="button" className="btn ghost" onClick={onClose} disabled={isPending}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={isPending}>
              {isPending ? (
                <>
                  <Spinner /> Saving…
                </>
              ) : (
                'Save profile'
              )}
            </button>
          </div>
        </form>
      )}

      {activeTab === 'rate' && <RateCard workerId={worker.workerId} companyId={companyId} />}
    </Modal>
  );
}

/** Small labeled field wrapper, matching the legacy .field pattern. */
function Field({
  id,
  label,
  required,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  /** Pass undefined to omit — use conditional spread at call-site per exactOptionalPropertyTypes. */
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && <span className="req"> *</span>}
      </label>
      {children}
      {error != null && <div className="field-err">{error}</div>}
    </div>
  );
}
