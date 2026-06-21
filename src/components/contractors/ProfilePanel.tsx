'use client';

import { type FormEvent, useEffect, useState, useTransition } from 'react';
import { Modal, useTablist, useToast, useUnsavedGuard } from '@/components/ui';
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
import type { ContractType } from '@/types/schemas/contractors';
import { PayTab } from './profile/PayTab';
import { PersonalTab } from './profile/PersonalTab';
import { PortalLoginTab } from './profile/PortalLoginTab';
import { ProfileTab } from './profile/ProfileTab';
import type { FormState } from './profile/types';

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
        <ProfileTab
          worker={worker}
          fullName={fullName}
          photoUrl={photoUrl}
          photoBusy={photoBusy}
          onPhoto={handlePhoto}
          form={form}
          set={set}
          errors={errors}
          isPending={isPending}
          serverError={serverError}
          onSubmit={handleSave}
          panelProps={tablist.panelProps()}
        />
      )}

      {/* ─── Pay & payout tab ─── */}
      {activeTab === 'pay' && (
        <PayTab
          worker={worker}
          companyId={companyId}
          companyName={companyName}
          companies={companies}
          engagements={engagements}
          updateEng={updateEng}
          saveEng={saveEng}
          assignTo={assignTo}
          setAssignTo={setAssignTo}
          handleAssign={handleAssign}
          form={form}
          set={set}
          errors={errors}
          isPending={isPending}
          serverError={serverError}
          onSubmit={handleSave}
          panelProps={tablist.panelProps()}
        />
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
