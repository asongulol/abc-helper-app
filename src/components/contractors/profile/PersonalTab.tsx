import { EmailInput, PhoneInput } from '@/components/ui';
import { Field } from './Field';
import { SaveBar } from './SaveBar';
import { type ProfileTabProps, SECTION_H4 } from './types';

// Dropdown options — verbatim from the legacy app (matches the portal profile).
const RELATIONSHIP = [
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
const MARITAL = ['Single', 'Married', 'Widowed', 'Separated', 'Annulled', 'Divorced'] as const;
const EDUCATION = [
  'Elementary',
  'High School',
  'Some College',
  'College',
  'Masters',
  'Doctorate',
] as const;
const GRAD_YEARS = Array.from({ length: 61 }, (_, i) => String(new Date().getFullYear() - i));

// Hire-date sanity bounds for the native picker (real guard is the schema — #039).
const HIRE_MIN = '2000-01-01';
const HIRE_MAX = (() => {
  const d = new Date();
  return `${d.getFullYear() + 1}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

// Default shift in Philippine time that mirrors 8:00 AM – 5:00 PM US Eastern.
const SHIFT_ET_START = '20:00';
const SHIFT_ET_END = '05:00';

/** Personal / HR tab — contact, shift, addresses, emergency/personal, payout tags. */
export function PersonalTab({
  form,
  set,
  errors,
  isPending,
  serverError,
  onSubmit,
  panelProps,
}: ProfileTabProps) {
  return (
    <form onSubmit={onSubmit} noValidate {...panelProps}>
      <section>
        <h4 style={SECTION_H4}>Contact</h4>
        <div className="grid-2">
          <Field id="pp-work-email" label="Work email (@abckidsny.com)" error={errors.workEmail}>
            <EmailInput
              id="pp-work-email"
              work
              value={form.workEmail}
              onChange={(v) => set('workEmail', v)}
              disabled={isPending}
            />
          </Field>
          <Field id="pp-mobile" label="Mobile (personal)">
            <PhoneInput
              id="pp-mobile"
              defaultCountry="PH"
              value={form.mobile}
              onChange={(v) => set('mobile', v)}
              disabled={isPending}
            />
          </Field>
          <Field id="pp-work-number" label="Work number">
            <PhoneInput
              id="pp-work-number"
              defaultCountry="US"
              value={form.workNumber}
              onChange={(v) => set('workNumber', v)}
              disabled={isPending}
            />
          </Field>
          <Field id="pp-ext" label="Ext.">
            <input
              id="pp-ext"
              value={form.workExtension}
              onChange={(e) => set('workExtension', e.target.value)}
              placeholder="x123"
              disabled={isPending}
            />
          </Field>
          <Field id="pp-hire" label="Hire date" error={errors.hireDate}>
            <input
              id="pp-hire"
              type="date"
              min={HIRE_MIN}
              max={HIRE_MAX}
              value={form.hireDate}
              onChange={(e) => set('hireDate', e.target.value)}
              disabled={isPending}
            />
          </Field>
          <Field id="pp-dob" label="Date of birth" error={errors.dateOfBirth}>
            <input
              id="pp-dob"
              type="date"
              value={form.dateOfBirth}
              onChange={(e) => set('dateOfBirth', e.target.value)}
              disabled={isPending}
            />
          </Field>
        </div>
      </section>

      <section style={{ marginTop: 20 }}>
        <h4 style={SECTION_H4}>Shift (Philippine time)</h4>
        <div className="grid-2">
          <Field id="pp-shift-start" label="Shift start">
            <input
              id="pp-shift-start"
              type="time"
              value={form.shiftStart}
              onChange={(e) => set('shiftStart', e.target.value)}
              disabled={isPending}
            />
          </Field>
          <Field id="pp-shift-end" label="Shift end">
            <input
              id="pp-shift-end"
              type="time"
              value={form.shiftEnd}
              onChange={(e) => set('shiftEnd', e.target.value)}
              disabled={isPending}
            />
          </Field>
        </div>
        <button
          type="button"
          className="btn ghost sm"
          style={{ marginTop: 8 }}
          disabled={isPending}
          onClick={() => {
            set('shiftStart', SHIFT_ET_START);
            set('shiftEnd', SHIFT_ET_END);
          }}
        >
          Reset to 8–5 ET
        </button>
      </section>

      <section style={{ marginTop: 20 }}>
        <h4 style={SECTION_H4}>Addresses</h4>
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
          <Field id="pp-landmark" label="Landmark">
            <input
              id="pp-landmark"
              value={form.addressLandmark}
              onChange={(e) => set('addressLandmark', e.target.value)}
              disabled={isPending}
            />
          </Field>
          <Field id="pp-postal" label="Postal code">
            <input
              id="pp-postal"
              value={form.postalCode}
              onChange={(e) => set('postalCode', e.target.value)}
              disabled={isPending}
            />
          </Field>
        </div>
      </section>

      <section style={{ marginTop: 20 }}>
        <h4 style={SECTION_H4}>Emergency & personal</h4>
        <div className="grid-2">
          <Field id="pp-em-name" label="Emergency contact name">
            <input
              id="pp-em-name"
              value={form.emergencyName}
              onChange={(e) => set('emergencyName', e.target.value)}
              disabled={isPending}
            />
          </Field>
          <Field id="pp-em-rel" label="Emergency relationship">
            <select
              id="pp-em-rel"
              value={form.emergencyRelationship}
              onChange={(e) => set('emergencyRelationship', e.target.value)}
              disabled={isPending}
            >
              <option value="">— Select —</option>
              {RELATIONSHIP.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <Field id="pp-em-mobile" label="Emergency mobile">
            <PhoneInput
              id="pp-em-mobile"
              defaultCountry="PH"
              value={form.emergencyMobile}
              onChange={(v) => set('emergencyMobile', v)}
              disabled={isPending}
            />
          </Field>
          <Field id="pp-marital" label="Marital status">
            <select
              id="pp-marital"
              value={form.maritalStatus}
              onChange={(e) => set('maritalStatus', e.target.value)}
              disabled={isPending}
            >
              <option value="">— Select —</option>
              {MARITAL.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <Field id="pp-edu" label="Highest Degree Attained">
            <select
              id="pp-edu"
              value={form.educationLevel}
              onChange={(e) => set('educationLevel', e.target.value)}
              disabled={isPending}
            >
              <option value="">— Select —</option>
              {EDUCATION.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <Field id="pp-course" label="Degree and Major">
            <input
              id="pp-course"
              value={form.course}
              onChange={(e) => set('course', e.target.value)}
              disabled={isPending}
            />
          </Field>
          <Field id="pp-grad" label="Year graduated">
            <select
              id="pp-grad"
              value={form.yearGraduated}
              onChange={(e) => set('yearGraduated', e.target.value)}
              disabled={isPending}
            >
              <option value="">— Select —</option>
              {GRAD_YEARS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <Field id="pp-school" label="School">
            <input
              id="pp-school"
              value={form.school}
              onChange={(e) => set('school', e.target.value)}
              disabled={isPending}
            />
          </Field>
        </div>
      </section>

      <section style={{ marginTop: 20 }}>
        <h4 style={SECTION_H4}>About / culture</h4>
        <p className="sub" style={{ margin: '-6px 0 12px' }}>
          Fun facts — contractors can fill these in during onboarding.
        </p>
        <div className="grid-2">
          <Field id="pp-fav-color" label="Favorite color">
            <input
              id="pp-fav-color"
              value={form.favoriteColor}
              onChange={(e) => set('favoriteColor', e.target.value)}
              disabled={isPending}
            />
          </Field>
          <Field id="pp-fav-food" label="Favorite food">
            <input
              id="pp-fav-food"
              value={form.favoriteFood}
              onChange={(e) => set('favoriteFood', e.target.value)}
              disabled={isPending}
            />
          </Field>
        </div>
        <div className="field">
          <label htmlFor="pp-motto">Personal motto</label>
          <input
            id="pp-motto"
            value={form.motto}
            onChange={(e) => set('motto', e.target.value)}
            disabled={isPending}
          />
        </div>
      </section>

      <section style={{ marginTop: 20 }}>
        <h4 style={SECTION_H4}>Payout tags</h4>
        <div className="grid-2">
          <Field id="pp-gcash" label="GCash">
            <input
              id="pp-gcash"
              value={form.gcash}
              onChange={(e) => set('gcash', e.target.value)}
              disabled={isPending}
            />
          </Field>
          <Field id="pp-paymaya" label="PayMaya">
            <input
              id="pp-paymaya"
              value={form.paymaya}
              onChange={(e) => set('paymaya', e.target.value)}
              disabled={isPending}
            />
          </Field>
          <Field id="pp-paypal" label="PayPal">
            <input
              id="pp-paypal"
              value={form.paypal}
              onChange={(e) => set('paypal', e.target.value)}
              disabled={isPending}
            />
          </Field>
          <Field id="pp-wisetag" label="Wise Tag">
            <input
              id="pp-wisetag"
              value={form.wiseTag}
              onChange={(e) => set('wiseTag', e.target.value)}
              placeholder="@yourtag"
              disabled={isPending}
            />
          </Field>
        </div>
      </section>

      <SaveBar isPending={isPending} serverError={serverError} />
    </form>
  );
}
