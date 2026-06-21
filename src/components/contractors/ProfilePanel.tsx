'use client';

import { type FormEvent, useEffect, useState, useTransition } from 'react';
import { EmailInput, Modal, useTablist, useToast, useUnsavedGuard } from '@/components/ui';
import { createBrowserSupabase } from '@/db/clients/browser';
import type { RosterWorker } from '@/db/queries/workers';
import {
  assignWorkerCompany,
  getWorkerCompanies,
  getWorkerPhotoUrl,
  saveWorkerCompanyLink,
  saveWorkerProfile,
  setWorkerPhoto,
  type WorkerEngagement,
} from '@/server/actions/contractors';
import { CONTRACT_OPTIONS, type ContractType } from '@/types/schemas/contractors';
import { Field } from './profile/Field';
import { PersonalTab } from './profile/PersonalTab';
import { PortalLoginTab } from './profile/PortalLoginTab';
import { SaveBar } from './profile/SaveBar';
import { type FormState, SECTION_H4 } from './profile/types';
import { RateCard } from './RateCard';

type Props = {
  worker: RosterWorker;
  companyId: string;
  companyName?: string;
  /** All companies (employer + clients) for the engagements assign-to select. */
  companies?: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (updated: RosterWorker) => void;
};

type TabKey = 'profile' | 'pay' | 'personal' | 'portal';
const TAB_KEYS = ['profile', 'pay', 'personal', 'portal'] as const satisfies readonly TabKey[];

function toForm(w: RosterWorker): FormState {
  return {
    firstName: w.firstName,
    middleName: w.middleName ?? '',
    lastName: w.lastName,
    email: w.email ?? '',
    workEmail: w.workEmail ?? '',
    mobile: w.mobile ?? '',
    workNumber: w.workNumber ?? '',
    workExtension: w.workExtension ?? '',
    hireDate: w.hireDate ?? '',
    dateOfBirth: w.dateOfBirth ?? '',
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
    billRateUsd: w.billRateUsd != null ? String(w.billRateUsd) : '',
    sessionRateUsd: w.sessionRateUsd != null ? String(w.sessionRateUsd) : '',
    linkStatus:
      w.linkStatus === 'ended' ? 'ended' : w.linkStatus === 'inactive' ? 'inactive' : 'active',
    shiftStart: w.shiftStart ?? '',
    shiftEnd: w.shiftEnd ?? '',
    emergencyName: w.emergencyName ?? '',
    emergencyRelationship: w.emergencyRelationship ?? '',
    emergencyMobile: w.emergencyMobile ?? '',
    maritalStatus: w.maritalStatus ?? '',
    educationLevel: w.educationLevel ?? '',
    course: w.course ?? '',
    yearGraduated: w.yearGraduated ?? '',
    school: w.school ?? '',
    gcash: w.gcash ?? '',
    paymaya: w.paymaya ?? '',
    paypal: w.paypal ?? '',
    wiseTag: w.wiseTag ?? '',
  };
}

type ValidPayoutMethod = 'wise' | 'bpi' | 'gcash' | 'paymaya' | 'paypal';
type ValidWorkerStatus = 'active' | 'inactive' | 'ended';

export function ProfilePanel({
  worker,
  companyId,
  companyName,
  companies = [],
  onClose,
  onSaved,
}: Props) {
  const { notify } = useToast();
  const [form, setForm] = useState<FormState>(() => toForm(worker));
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [serverError, setServerError] = useState('');
  const [isPending, startTransition] = useTransition();
  const [activeTab, setActiveTab] = useState<TabKey>('profile');
  const tablist = useTablist(TAB_KEYS, activeTab, setActiveTab);

  // Portal & login local state.
  const [loginBusy, startLogin] = useTransition();
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  // Photo (avatars bucket: admin uploads client-side, display via signed URL).
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  // Client engagements (all of this worker's company links).
  const [engagements, setEngagements] = useState<WorkerEngagement[]>([]);
  const [assignTo, setAssignTo] = useState('');

  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(worker));
  const [pendingClose, setPendingClose] = useState(false);
  useUnsavedGuard({ dirty });
  const guardedClose = () => {
    if (dirty) setPendingClose(true);
    else onClose();
  };

  const fullName = [worker.firstName, worker.middleName, worker.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per worker.
  useEffect(() => {
    if (!worker.photoUrl) return;
    getWorkerPhotoUrl({ workerId: worker.workerId }).then((r) => {
      if (r.ok) setPhotoUrl(r.data.url);
    });
  }, [worker.workerId]);

  const handlePhoto = (file: File | undefined) => {
    if (!file) return;
    setPhotoBusy(true);
    (async () => {
      try {
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
        const path = `${worker.workerId}/${Date.now()}.${ext}`;
        const sb = createBrowserSupabase();
        const up = await sb.storage.from('avatars').upload(path, file, { upsert: true });
        if (up.error) {
          notify(up.error.message, { type: 'error' });
          return;
        }
        const res = await setWorkerPhoto({ workerId: worker.workerId, path });
        if (!res.ok) {
          notify(res.error, { type: 'error' });
          return;
        }
        const signed = await getWorkerPhotoUrl({ workerId: worker.workerId });
        if (signed.ok) setPhotoUrl(signed.data.url);
        notify('Photo updated.', { type: 'success' });
      } catch (e) {
        notify(e instanceof Error ? e.message : 'Upload failed.', {
          type: 'error',
        });
      } finally {
        setPhotoBusy(false);
      }
    })();
  };

  useEffect(() => {
    getWorkerCompanies({ workerId: worker.workerId }).then((r) => {
      if (r.ok) setEngagements(r.data.engagements);
    });
  }, [worker.workerId]);

  const updateEng = (i: number, patch: Partial<WorkerEngagement>) =>
    setEngagements((arr) => arr.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));

  const saveEng = (e: WorkerEngagement) => {
    startTransition(async () => {
      const res = await saveWorkerCompanyLink({
        workerId: worker.workerId,
        companyId: e.companyId,
        role: e.role,
        billRateUsd: e.billRateUsd,
        sessionRateUsd: e.sessionRateUsd,
        contract: e.contract as ContractType,
        status: e.status === 'inactive' ? 'inactive' : e.status === 'ended' ? 'ended' : 'active',
      });
      notify(res.ok ? 'Engagement saved.' : res.error, {
        type: res.ok ? 'success' : 'error',
      });
    });
  };

  const handleAssign = () => {
    if (!assignTo) return;
    startTransition(async () => {
      const res = await assignWorkerCompany({
        workerId: worker.workerId,
        companyId: assignTo,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      notify('Assigned to company.', { type: 'success' });
      setAssignTo('');
      const r = await getWorkerCompanies({ workerId: worker.workerId });
      if (r.ok) setEngagements(r.data.engagements);
    });
  };

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
    if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) errs.email = 'Invalid email.';
    if (form.workEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.workEmail))
      errs.workEmail = 'Invalid email.';
    if (form.hireDate && !/^\d{4}-\d{2}-\d{2}$/.test(form.hireDate))
      errs.hireDate = 'Must be YYYY-MM-DD.';
    if (form.dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(form.dateOfBirth))
      errs.dateOfBirth = 'Must be YYYY-MM-DD.';
    if (form.weeklyHours !== '' && Number.isNaN(Number(form.weeklyHours)))
      errs.weeklyHours = 'Must be a number.';
    if (form.billRateUsd !== '' && Number.isNaN(Number(form.billRateUsd)))
      errs.billRateUsd = 'Must be a number.';
    if (form.sessionRateUsd !== '' && Number.isNaN(Number(form.sessionRateUsd)))
      errs.sessionRateUsd = 'Must be a number.';
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      // Surface the first error's tab so the user sees what's wrong.
      if (errs.firstName || errs.lastName || errs.email) setActiveTab('profile');
      else if (errs.billRateUsd || errs.sessionRateUsd) setActiveTab('pay');
      else setActiveTab('personal');
      return false;
    }
    return true;
  }

  function handleSave(e: FormEvent) {
    e.preventDefault();
    doSave();
  }

  function doSave() {
    if (!validate()) return;
    setServerError('');

    const PAYOUT_METHODS: ValidPayoutMethod[] = ['wise', 'bpi', 'gcash', 'paymaya', 'paypal'];
    const payoutMethod: ValidPayoutMethod | null = PAYOUT_METHODS.includes(
      form.payoutMethod as ValidPayoutMethod,
    )
      ? (form.payoutMethod as ValidPayoutMethod)
      : null;

    const LINK_STATUSES: ValidWorkerStatus[] = ['active', 'inactive', 'ended'];
    const linkStatus: ValidWorkerStatus = LINK_STATUSES.includes(form.linkStatus)
      ? form.linkStatus
      : 'active';

    const weeklyHours = form.weeklyHours !== '' ? Number(form.weeklyHours) : null;
    const billRateUsd = form.billRateUsd !== '' ? Number(form.billRateUsd) : null;
    const sessionRateUsd = form.sessionRateUsd !== '' ? Number(form.sessionRateUsd) : null;
    const str = (v: string) => (v.trim() === '' ? null : v.trim());

    startTransition(async () => {
      const result = await saveWorkerProfile({
        workerId: worker.workerId,
        companyId,
        firstName: form.firstName.trim(),
        middleName: str(form.middleName),
        lastName: form.lastName.trim(),
        email: str(form.email),
        mobile: str(form.mobile),
        hireDate: form.hireDate || null,
        phAddress: str(form.phAddress),
        permanentAddress: str(form.permanentAddress),
        addressLandmark: str(form.addressLandmark),
        postalCode: str(form.postalCode),
        payoutMethod,
        healthAllowanceEligible: form.healthAllowanceEligible,
        thirteenthMonthEligible: form.thirteenthMonthEligible,
        workEmail: str(form.workEmail),
        workNumber: str(form.workNumber),
        workExtension: str(form.workExtension),
        shiftStart: str(form.shiftStart),
        shiftEnd: str(form.shiftEnd),
        dateOfBirth: form.dateOfBirth || null,
        emergencyName: str(form.emergencyName),
        emergencyRelationship: str(form.emergencyRelationship),
        emergencyMobile: str(form.emergencyMobile),
        maritalStatus: str(form.maritalStatus),
        educationLevel: str(form.educationLevel),
        course: str(form.course),
        yearGraduated: str(form.yearGraduated),
        school: str(form.school),
        gcash: str(form.gcash),
        paymaya: str(form.paymaya),
        paypal: str(form.paypal),
        wiseTag: str(form.wiseTag),
        contract: form.contract,
        role: str(form.role),
        hubstaffName: str(form.hubstaffName),
        weeklyHours,
        billRateUsd,
        sessionRateUsd,
        linkStatus,
      });
      if (!result.ok) {
        setServerError(result.error);
        return;
      }
      const updated: RosterWorker = {
        ...worker,
        firstName: form.firstName.trim(),
        middleName: str(form.middleName),
        lastName: form.lastName.trim(),
        email: str(form.email),
        mobile: str(form.mobile),
        hireDate: form.hireDate || null,
        phAddress: str(form.phAddress),
        permanentAddress: str(form.permanentAddress),
        addressLandmark: str(form.addressLandmark),
        postalCode: str(form.postalCode),
        payoutMethod,
        healthAllowanceEligible: form.healthAllowanceEligible,
        thirteenthMonthEligible: form.thirteenthMonthEligible,
        workEmail: str(form.workEmail),
        workNumber: str(form.workNumber),
        workExtension: str(form.workExtension),
        shiftStart: str(form.shiftStart),
        shiftEnd: str(form.shiftEnd),
        dateOfBirth: form.dateOfBirth || null,
        emergencyName: str(form.emergencyName),
        emergencyRelationship: str(form.emergencyRelationship),
        emergencyMobile: str(form.emergencyMobile),
        maritalStatus: str(form.maritalStatus),
        educationLevel: str(form.educationLevel),
        course: str(form.course),
        yearGraduated: str(form.yearGraduated),
        school: str(form.school),
        gcash: str(form.gcash),
        paymaya: str(form.paymaya),
        paypal: str(form.paypal),
        wiseTag: str(form.wiseTag),
        contract: form.contract,
        role: str(form.role),
        hubstaffName: str(form.hubstaffName),
        weeklyHours,
        billRateUsd,
        sessionRateUsd,
        linkStatus,
        workerStatus: linkStatus === 'active' ? 'active' : linkStatus,
      };
      onSaved(updated);
    });
  }

  // ─── Portal & login handlers ────────────────────────────────────────────────
  const runLogin = (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => {
    startLogin(async () => {
      try {
        const res = (await fn()) as {
          ok: boolean;
          error?: string;
          data?: { tempPassword?: string };
        };
        if (res.ok) {
          notify(ok, { type: 'success' });
          if (res.data?.tempPassword) setTempPassword(res.data.tempPassword);
        } else {
          notify(res.error ?? 'Failed.', { type: 'error' });
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Failed.', {
          type: 'error',
        });
      }
    });
  };

  const tabs: ReadonlyArray<{ key: TabKey; label: string }> = [
    { key: 'profile', label: 'Profile' },
    { key: 'pay', label: 'Pay & payout' },
    { key: 'personal', label: 'Personal / HR' },
    { key: 'portal', label: 'Portal & login' },
  ];

  return (
    <Modal title={fullName || 'New contractor'} onClose={guardedClose} maxWidth={720}>
      <p className="sub" style={{ margin: '0 0 12px' }}>
        {companyName ? `${companyName} · ` : ''}
        {worker.linkStatus}
      </p>

      <div
        role="tablist"
        aria-label="Contractor details sections"
        style={{
          display: 'flex',
          gap: 4,
          marginBottom: 16,
          borderBottom: '1px solid var(--border)',
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            {...tablist.tabProps(t.key)}
            className={activeTab === t.key ? 'btn sm' : 'btn ghost sm'}
            style={{ borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ─── Profile tab ─── */}
      {activeTab === 'profile' && (
        <form onSubmit={handleSave} noValidate {...tablist.panelProps()}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              marginBottom: 16,
            }}
          >
            {photoUrl ? (
              // biome-ignore lint/performance/noImgElement: remote Supabase signed-URL photo fetched at runtime, not a static asset
              <img
                src={photoUrl}
                alt={fullName}
                width={56}
                height={56}
                style={{
                  borderRadius: '50%',
                  objectFit: 'cover',
                  boxShadow: '0 0 0 2px var(--gold)',
                }}
              />
            ) : (
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  background: 'var(--navy, #1f3a68)',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  fontSize: 20,
                }}
              >
                {(worker.firstName[0] ?? '?').toUpperCase()}
              </div>
            )}
            <label className="btn ghost sm" style={{ cursor: 'pointer' }}>
              {photoBusy ? 'Uploading…' : photoUrl ? 'Change photo' : 'Upload photo'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                disabled={photoBusy}
                onChange={(e) => handlePhoto(e.target.files?.[0])}
              />
            </label>
          </div>
          <div className="grid-2">
            <Field id="pp-first" label="First name" required error={errors.firstName}>
              <input
                id="pp-first"
                value={form.firstName}
                onChange={(e) => set('firstName', e.target.value)}
                disabled={isPending}
              />
            </Field>
            <Field id="pp-middle" label="Middle name (optional)">
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
                disabled={isPending}
              />
            </Field>
            <Field id="pp-contract" label="Contract">
              <select
                id="pp-contract"
                value={form.contract}
                onChange={(e) => set('contract', e.target.value as ContractType)}
                disabled={isPending}
              >
                {CONTRACT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="pp-role" label="Role">
              <input
                id="pp-role"
                value={form.role}
                onChange={(e) => set('role', e.target.value)}
                placeholder="e.g. Billing Associate"
                disabled={isPending}
              />
            </Field>
            <Field id="pp-hours" label="Expected hours / week" error={errors.weeklyHours}>
              <input
                id="pp-hours"
                type="number"
                min="0"
                max="168"
                step="0.5"
                value={form.weeklyHours}
                onChange={(e) => set('weeklyHours', e.target.value)}
                placeholder="40"
                disabled={isPending}
              />
            </Field>
            <Field id="pp-payout" label="Payout method">
              <select
                id="pp-payout"
                value={form.payoutMethod}
                onChange={(e) => set('payoutMethod', e.target.value)}
                disabled={isPending}
              >
                <option value="">— not set —</option>
                <option value="wise">Wise</option>
                <option value="bpi">BPI</option>
                <option value="gcash">Gcash</option>
                <option value="paymaya">Paymaya</option>
                <option value="paypal">Paypal</option>
              </select>
            </Field>
            <Field id="pp-email" label="Personal email" error={errors.email}>
              <EmailInput
                id="pp-email"
                value={form.email}
                onChange={(v) => set('email', v)}
                disabled={isPending}
              />
            </Field>
            <Field id="pp-hubstaff" label="Hubstaff name (import match)">
              <input
                id="pp-hubstaff"
                value={form.hubstaffName}
                onChange={(e) => set('hubstaffName', e.target.value)}
                disabled={isPending}
              />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 24, marginTop: 16 }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={form.healthAllowanceEligible}
                onChange={(e) => set('healthAllowanceEligible', e.target.checked)}
                disabled={isPending}
              />
              Health allowance
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={form.thirteenthMonthEligible}
                onChange={(e) => set('thirteenthMonthEligible', e.target.checked)}
                disabled={isPending}
              />
              13th-month
            </label>
          </div>
          <SaveBar isPending={isPending} serverError={serverError} />
        </form>
      )}

      {/* ─── Pay & payout tab ─── */}
      {activeTab === 'pay' && (
        <form onSubmit={handleSave} noValidate {...tablist.panelProps()}>
          <section>
            <h4 style={SECTION_H4}>
              Per-company engagement{companyName ? ` · ${companyName}` : ''}
            </h4>
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
          <SaveBar isPending={isPending} serverError={serverError} />
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
        </form>
      )}

      {/* ─── Personal / HR tab ─── */}
      {activeTab === 'personal' && (
        <PersonalTab
          form={form}
          set={set}
          errors={errors}
          isPending={isPending}
          serverError={serverError}
          onSubmit={handleSave}
          panelProps={tablist.panelProps()}
        />
      )}

      {/* ─── Portal & login tab ─── */}
      {activeTab === 'portal' && (
        <PortalLoginTab
          worker={worker}
          loginBusy={loginBusy}
          tempPassword={tempPassword}
          runLogin={runLogin}
          panelProps={tablist.panelProps()}
        />
      )}
      {pendingClose && (
        <Modal title="Unsaved changes" onClose={() => setPendingClose(false)} maxWidth={440}>
          <p className="sub" style={{ marginBottom: 14 }}>
            You have unsaved changes in this contractor's profile. Save them before leaving, or
            discard them?
          </p>
          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => setPendingClose(false)}>
              Stay on page
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                setPendingClose(false);
                onClose();
              }}
            >
              Discard changes
            </button>
            <button
              type="button"
              className="btn"
              disabled={isPending}
              onClick={() => {
                setPendingClose(false);
                doSave();
              }}
            >
              Save
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
