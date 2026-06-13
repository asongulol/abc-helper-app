'use client';

import { useToast } from '@/components/ui';
import { updateOwnProfile } from '@/server/actions/portal';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

type Profile = {
  id: string;
  first_name: string;
  last_name: string;
  middle_name: string | null;
  email: string | null;
  mobile: string | null;
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
}

const FIELD_LABEL: Record<string, string> = {
  first_name: 'First name',
  middle_name: 'Middle name',
  last_name: 'Last name',
  mobile: 'Mobile',
  ph_address: 'Current PH address',
  permanent_address: 'Permanent address',
  address_landmark: 'Landmark',
  postal_code: 'Postal code',
  date_of_birth: 'Date of birth',
  gcash: 'GCash',
  paymaya: 'PayMaya',
  paypal: 'PayPal',
  wise_tag: 'Wise tag',
  emergency_name: 'Emergency contact name',
  emergency_relationship: 'Relationship',
  emergency_mobile: 'Emergency mobile',
  marital_status: 'Marital status',
  education_level: 'Education level',
  course: 'Course/Program',
  year_graduated: 'Year graduated',
  school: 'School/University',
};

export const PortalProfile = ({ profile, editableFields }: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>(() => {
    if (!profile) return {};
    const out: Record<string, string> = {};
    for (const f of editableFields) {
      const v = (profile as Record<string, unknown>)[f];
      out[f] = v != null ? String(v) : '';
    }
    return out;
  });

  if (!profile) {
    return (
      <div className="card">
        <p className="sub">Profile not found.</p>
      </div>
    );
  }

  const handleSave = () => {
    const payload: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(fields)) {
      payload[k] = v.trim() === '' ? null : v.trim();
    }
    startTransition(async () => {
      const result = await updateOwnProfile(payload);
      if (result.ok) {
        notify('Profile updated.', { type: 'success' });
        setEditing(false);
        router.refresh();
      } else {
        notify(result.error, { type: 'error' });
      }
    });
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Profile</h2>
          {!editing && (
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </div>
        <p className="sub">
          {profile.first_name} {profile.middle_name ? `${profile.middle_name} ` : ''}
          {profile.last_name} · {profile.email ?? '—'}
        </p>
      </div>

      {/* Read-only fields */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>Account info</h3>
        <dl style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
          {[
            ['Status', profile.status],
            ['Hire date', profile.hire_date ?? '—'],
            ['Payout method', profile.payout_method ?? '—'],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="sub" style={{ fontSize: 11 }}>
                {label}
              </dt>
              <dd style={{ margin: 0 }}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Editable fields */}
      <div className="card">
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>
          {editing ? 'Edit profile' : 'Profile details'}
        </h3>

        {editing ? (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                gap: 12,
                marginBottom: 16,
              }}
            >
              {editableFields.map((f) => (
                <label key={f} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span className="sub" style={{ fontSize: 11 }}>
                    {FIELD_LABEL[f] ?? f}
                  </span>
                  <input
                    type={f === 'date_of_birth' ? 'date' : 'text'}
                    value={fields[f] ?? ''}
                    onChange={(e) => setFields((cur) => ({ ...cur, [f]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" disabled={isPending} onClick={handleSave}>
                {isPending ? 'Saving…' : 'Save changes'}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setEditing(false)}
                disabled={isPending}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: '6px 16px',
            }}
          >
            {editableFields.map((f) => (
              <div key={f}>
                <dt className="sub" style={{ fontSize: 11 }}>
                  {FIELD_LABEL[f] ?? f}
                </dt>
                <dd style={{ margin: 0 }}>
                  {(profile as Record<string, unknown>)[f] != null
                    ? String((profile as Record<string, unknown>)[f])
                    : '—'}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </>
  );
};
