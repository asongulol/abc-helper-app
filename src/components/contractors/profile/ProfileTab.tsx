import { EmailInput } from '@/components/ui';
import type { RosterWorker } from '@/db/queries/workers';
import {
  CONTRACT_OPTIONS,
  type ContractType,
  PAY_BASIS_OPTIONS,
  type PayBasis,
} from '@/types/schemas/contractors';
import { Field } from './Field';
import { SaveBar } from './SaveBar';
import type { ProfileTabProps } from './types';

interface Props extends ProfileTabProps {
  worker: RosterWorker;
  fullName: string;
  photoUrl: string | null;
  photoBusy: boolean;
  onPhoto: (file: File | undefined) => void;
}

/** Profile tab — photo, name, contract, role, hours, payout method, email, hubstaff name. */
export function ProfileTab({
  worker,
  fullName,
  photoUrl,
  photoBusy,
  onPhoto,
  form,
  set,
  errors,
  isPending,
  serverError,
  onSubmit,
  panelProps,
}: Props) {
  return (
    <form onSubmit={onSubmit} noValidate {...panelProps}>
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
            onChange={(e) => onPhoto(e.target.files?.[0])}
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
            onChange={(e) => {
              const next = e.target.value as ContractType;
              set('contract', next);
              if (next !== 'PHS') set('payBasis', null);
            }}
            disabled={isPending}
          >
            {CONTRACT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {form.contract === 'PHS' && (
          <Field id="pp-basis" label="Pay basis" required>
            <select
              id="pp-basis"
              value={form.payBasis ?? ''}
              onChange={(e) => set('payBasis', (e.target.value || null) as PayBasis | null)}
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
  );
}
