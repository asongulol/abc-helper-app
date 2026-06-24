'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTablist, useToast } from '@/components/ui';
import { formatPhone, PhoneInput } from '@/components/ui/PhoneInput';
import { updateOwnProfile } from '@/server/actions/portal';

type Profile = {
  id: string;
  first_name: string;
  last_name: string;
  middle_name: string | null;
  email: string | null;
  work_email: string | null;
  mobile: string | null;
  work_number: string | null;
  work_extension: string | null;
  ph_address: string | null;
  permanent_address: string | null;
  address_landmark: string | null;
  postal_code: string | null;
  date_of_birth: string | null;
  gcash: string | null;
  paymaya: string | null;
  paypal: string | null;
  wise_tag: string | null;
  emergency_name: string | null;
  emergency_relationship: string | null;
  emergency_mobile: string | null;
  marital_status: string | null;
  education_level: string | null;
  course: string | null;
  year_graduated: string | null;
  school: string | null;
  profile_extras: unknown;
  payout_method: string | null;
  status: string;
  hire_date: string | null;
} | null;

interface Props {
  profile: Profile;
  editableFields: string[];
  /** Auth/login email — display fallback when workers.email is blank (mirrors the original). */
  authEmail?: string | null;
}

type FieldType = 'text' | 'tel' | 'date';
interface FieldDef {
  k: string;
  label: string;
  type?: FieldType;
  opts?: readonly string[];
  /** Mirrors another field via the "Same as current PH address" checkbox. */
  sameAs?: string;
  /** Wise Tag — renders the placeholder + signup link. */
  wise?: boolean;
  /** Stored in workers.profile_extras (jsonb) rather than a worker column. */
  ex?: boolean;
}

// Dropdown options — verbatim from the legacy app (portal/index.html ~937-948).
const REL_OPTS = [
  'Parent',
  'Spouse',
  'Sibling',
  'Child',
  'Grandparent',
  'Relative',
  'Friend',
  'Partner',
  'Guardian',
  'Other',
] as const;
const MARITAL_OPTS = ['Single', 'Married', 'Widowed', 'Separated', 'Annulled', 'Divorced'] as const;
const EDUCATION_OPTS = [
  'Elementary',
  'High School',
  'Some College',
  'College',
  'Masters',
  'Doctorate',
] as const;
const GRAD_YEARS = Array.from({ length: 60 }, (_, i) => String(new Date().getFullYear() - i));

// Field manifest — verbatim port of legacy FIELD_DEFS (portal/index.html ~940-949).
const FIELD_DEFS: ReadonlyArray<FieldDef & { s: string }> = [
  { k: 'first_name', label: 'First name', s: 'contact' },
  { k: 'middle_name', label: 'Middle name', s: 'contact' },
  { k: 'last_name', label: 'Last name', s: 'contact' },
  { k: 'mobile', label: 'Mobile', type: 'tel', s: 'contact' },
  { k: 'ph_address', label: 'Current PH address', s: 'contact' },
  {
    k: 'permanent_address',
    label: 'Permanent address',
    s: 'contact',
    sameAs: 'ph_address',
  },
  { k: 'address_landmark', label: 'Landmark', s: 'contact' },
  { k: 'postal_code', label: 'Postal code', s: 'contact' },
  { k: 'date_of_birth', label: 'Date of birth', type: 'date', s: 'contact' },
  { k: 'emergency_name', label: 'Emergency contact name', s: 'personal' },
  {
    k: 'emergency_relationship',
    label: 'Emergency contact relationship',
    opts: REL_OPTS,
    s: 'personal',
  },
  {
    k: 'emergency_mobile',
    label: 'Emergency contact mobile',
    type: 'tel',
    s: 'personal',
  },
  {
    k: 'marital_status',
    label: 'Marital status',
    opts: MARITAL_OPTS,
    s: 'personal',
  },
  {
    k: 'education_level',
    label: 'Highest Degree Attained',
    opts: EDUCATION_OPTS,
    s: 'personal',
  },
  { k: 'course', label: 'Degree and Major', s: 'personal' },
  {
    k: 'year_graduated',
    label: 'Year graduated',
    opts: GRAD_YEARS,
    s: 'personal',
  },
  { k: 'school', label: 'School', s: 'personal' },
  { k: 'gcash', label: 'GCash', s: 'payout' },
  { k: 'paymaya', label: 'PayMaya', s: 'payout' },
  { k: 'paypal', label: 'PayPal', s: 'payout' },
  { k: 'wise_tag', label: 'Wise Tag', wise: true, s: 'payout' },
  { k: 'nickname', label: 'Nickname', s: 'about', ex: true },
  { k: 'favorite_color', label: 'Favorite color', s: 'about', ex: true },
  { k: 'favorite_food', label: 'Favorite food', s: 'about', ex: true },
  { k: 'tshirt_size', label: 'T-shirt size', s: 'about', ex: true },
  { k: 'shoe_size', label: 'Shoe size', s: 'about', ex: true },
  { k: 'hobbies', label: 'Hobbies', s: 'about', ex: true },
  { k: 'motto', label: 'Personal motto', s: 'about', ex: true },
];

const SECS: ReadonlyArray<readonly [string, string]> = [
  ['contact', 'Contact'],
  ['personal', 'Personal'],
  ['payout', 'Payout'],
  ['about', 'About me'],
];
const SEC_KEYS = SECS.map(([k]) => k);

const fullName = (p: NonNullable<Profile>) =>
  [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');

export const PortalProfile = ({ profile, editableFields, authEmail }: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [psec, setPsec] = useState('contact');
  const tablist = useTablist(SEC_KEYS, psec, setPsec);
  const [sameAddr, setSameAddr] = useState(false);

  const extras = useMemo<Record<string, unknown>>(
    () =>
      profile?.profile_extras && typeof profile.profile_extras === 'object'
        ? (profile.profile_extras as Record<string, unknown>)
        : {},
    [profile],
  );

  const curVal = (f: FieldDef): string => {
    if (!profile) return '';
    const v = f.ex ? extras[f.k] : (profile as Record<string, unknown>)[f.k];
    return v != null ? String(v) : '';
  };

  const initial = useMemo(() => {
    const out: Record<string, string> = {};
    if (profile) {
      for (const f of FIELD_DEFS) {
        const v = f.ex ? extras[f.k] : (profile as Record<string, unknown>)[f.k];
        out[f.k] = v != null ? String(v) : '';
      }
    }
    return out;
  }, [profile, extras]);

  const [form, setForm] = useState<Record<string, string>>(initial);

  // Initial "Same as current" state mirrors the legacy: ticked when permanent
  // already equals current PH address.
  useEffect(() => {
    setSameAddr(
      !!profile?.ph_address && (profile.permanent_address ?? '') === (profile.ph_address ?? ''),
    );
  }, [profile]);

  // Keep permanent address synced to current while "Same as current" is ticked.
  useEffect(() => {
    if (sameAddr)
      setForm((x) =>
        x.permanent_address === x.ph_address ? x : { ...x, permanent_address: x.ph_address ?? '' },
      );
  }, [sameAddr]);

  if (!profile) {
    return (
      <div className="card">
        <p className="sub">Profile not found.</p>
      </div>
    );
  }

  const isEditable = (k: string) => editableFields.includes(k);
  const set = (k: string, v: string) => setForm((x) => ({ ...x, [k]: v }));

  const handleSave = () => {
    const payload: Record<string, string | null> = {};
    for (const f of FIELD_DEFS) {
      if (isEditable(f.k) && (form[f.k] ?? '') !== curVal(f)) payload[f.k] = form[f.k] ?? '';
    }
    if (Object.keys(payload).length === 0) {
      notify('Nothing changed.', { type: 'warn' });
      return;
    }
    startTransition(async () => {
      const res = await updateOwnProfile(payload);
      if (res.ok) {
        notify('Saved — thank you!', { type: 'success' });
        router.refresh();
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };

  const anyEditable = FIELD_DEFS.some((f) => isEditable(f.k));
  const secFields = FIELD_DEFS.filter((f) => f.s === psec);
  const secEditable = secFields.some((f) => isEditable(f.k));

  const initials =
    `${profile.first_name?.[0] ?? ''}${profile.last_name?.[0] ?? ''}`.toUpperCase() || '?';

  const renderControl = (f: FieldDef) => {
    if (!isEditable(f.k)) {
      const display = f.type === 'tel' ? formatPhone(curVal(f)) : curVal(f);
      return (
        <div style={{ padding: '6px 0', fontSize: 15 }}>
          {display || <span className="sub">—</span>}
        </div>
      );
    }
    const value = form[f.k] ?? '';
    if (f.opts) {
      const showCustom = !!value && !f.opts.includes(value);
      return (
        <select value={value} disabled={isPending} onChange={(e) => set(f.k, e.target.value)}>
          <option value="">Select…</option>
          {f.opts.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
          {showCustom && <option value={value}>{value}</option>}
        </select>
      );
    }
    if (f.type === 'tel') {
      return (
        <PhoneInput
          value={value}
          onChange={(v) => set(f.k, v)}
          defaultCountry="PH"
          disabled={isPending}
        />
      );
    }
    const mirrored = !!f.sameAs && sameAddr;
    return (
      <input
        type={f.type === 'date' ? 'date' : 'text'}
        value={value}
        disabled={isPending || mirrored}
        placeholder={f.wise ? '@yourtag' : ''}
        onChange={(e) => set(f.k, e.target.value)}
      />
    );
  };

  return (
    <>
      {/* Profile header card */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <div
            aria-hidden
            style={{
              flexShrink: 0,
              width: 44,
              height: 44,
              borderRadius: '50%',
              background: 'var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
            }}
          >
            {initials}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 18 }}>{fullName(profile) || '—'}</div>
            <div className="sub" style={{ margin: 0 }}>
              Engaged since {profile.hire_date ?? '—'}
            </div>
          </div>
        </div>
        <p className="sub" style={{ margin: '2px 0 0' }}>
          Personal email {profile.email || authEmail || '—'}
        </p>
        {profile.work_email && (
          <p className="sub" style={{ margin: '2px 0 0' }}>
            Work email {profile.work_email}
          </p>
        )}
        {profile.work_number && (
          <p className="sub" style={{ margin: '2px 0 0' }}>
            Work number {formatPhone(profile.work_number)}
            {profile.work_extension ? ` ext. ${profile.work_extension}` : ''}
          </p>
        )}
        <p className="sub" style={{ margin: '2px 0 0' }}>
          Paid via {profile.payout_method ?? '—'}
        </p>
      </div>

      {/* Tabbed profile */}
      <div role="tablist" aria-label="Profile sections" className="ptabs no-print">
        {SECS.map(([k, lbl]) => (
          <button key={k} type="button" {...tablist.tabProps(k)} className={k === psec ? 'on' : ''}>
            {lbl}
          </button>
        ))}
      </div>

      <div className="card" {...tablist.panelProps()}>
        <p className="sub" style={{ marginTop: 0 }}>
          {anyEditable
            ? 'Update your info and Save. Fields shown as plain text are managed by payroll.'
            : 'Editing is currently turned off by your payroll admin.'}
        </p>

        {secFields.map((f) => (
          <div key={f.k} style={{ margin: '8px 0' }}>
            <span className="sub" style={{ display: 'block' }}>
              {f.label}
            </span>
            {f.sameAs && isEditable(f.k) && (
              <label
                className="sub"
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  margin: '2px 0 4px',
                }}
              >
                <input
                  type="checkbox"
                  checked={sameAddr}
                  onChange={(e) => setSameAddr(e.target.checked)}
                />{' '}
                Same as current PH address
              </label>
            )}
            {renderControl(f)}
            {f.wise && isEditable('wise_tag') && (
              <a
                href="https://wise.com/invite/dic/olivert410"
                target="_blank"
                rel="noreferrer"
                style={{
                  fontSize: 13,
                  color: 'var(--accent)',
                  fontWeight: 600,
                  display: 'inline-block',
                  marginTop: 2,
                }}
              >
                Don&apos;t have a Wise account? Set one up →
              </a>
            )}
          </div>
        ))}

        {anyEditable && (
          <>
            <button
              type="button"
              className="btn"
              style={{ width: '100%', marginTop: 8 }}
              disabled={isPending}
              onClick={handleSave}
            >
              {isPending ? 'Saving…' : 'Save changes'}
            </button>
            {!secEditable && (
              <p className="sub" style={{ marginTop: 6, marginBottom: 0 }}>
                Nothing on this tab is editable right now — your changes on other tabs still save.
              </p>
            )}
          </>
        )}
      </div>

      <p className="sub" style={{ marginTop: 12 }}>
        Questions about your pay? Contact your payroll admin.
      </p>
    </>
  );
};
