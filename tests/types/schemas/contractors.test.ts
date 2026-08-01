import { describe, expect, it } from 'vitest';
import {
  hireDateRangeError,
  SaveWorkerProfileSchema,
  TerminateContractorSchema,
} from '@/types/schemas/contractors';

// Valid v4 UUID — Zod v4 .uuid()-style checks elsewhere reject the all-1s
// placeholder, but this module's `uuid()` helper accepts any 8-4-4-4-12 hex id.
const ID = '11111111-1111-4111-8111-111111111111';

const base = {
  workerId: ID,
  companyId: ID,
  firstName: 'Maria',
  middleName: null,
  lastName: 'Santos',
  email: null,
  mobile: null,
  hireDate: null,
  phAddress: null,
  permanentAddress: null,
  addressLandmark: null,
  postalCode: null,
  payoutMethod: null,
  healthAllowanceEligible: true,
  thirteenthMonthEligible: true,
  contract: 'FT' as const,
  payBasis: null,
  role: null,
  hubstaffName: null,
  weeklyHours: 40,
  billRateUsd: 25,
  sessionRateUsd: null,
  linkStatus: 'active' as const,
};

describe('SaveWorkerProfileSchema — Finding #016.2 human error messages', () => {
  it('rejects an over-long first name with the friendly length message', () => {
    const r = SaveWorkerProfileSchema.safeParse({ ...base, firstName: 'x'.repeat(300) });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]?.message).toBe(
      'Name is too long (max 80 characters).',
    );
  });

  it('rejects an over-long last name with the friendly length message', () => {
    const r = SaveWorkerProfileSchema.safeParse({ ...base, lastName: 'x'.repeat(300) });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]?.message).toBe(
      'Name is too long (max 80 characters).',
    );
  });

  it('rejects a negative bill rate with the friendly bounds message', () => {
    const r = SaveWorkerProfileSchema.safeParse({ ...base, billRateUsd: -50 });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]?.message).toBe('Rate must be between 0 and 100,000.');
  });

  it('rejects a bill rate over 100,000 with the friendly bounds message', () => {
    const r = SaveWorkerProfileSchema.safeParse({ ...base, billRateUsd: 200000 });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]?.message).toBe('Rate must be between 0 and 100,000.');
  });

  it('accepts a valid profile unchanged', () => {
    expect(SaveWorkerProfileSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an out-of-range hire date (#039)', () => {
    const r = SaveWorkerProfileSchema.safeParse({ ...base, hireDate: '1900-01-15' });
    expect(r.success).toBe(false);
    const r2 = SaveWorkerProfileSchema.safeParse({ ...base, hireDate: '2099-12-31' });
    expect(r2.success).toBe(false);
  });
});

// 'ended' closes rates and coverage as of a last day a status field has nowhere
// to put, so it is unrepresentable in anything a form posts (#81). An already
// ended link omits the field instead of posting its own status back.
describe('EditableWorkerStatusSchema — a form may not write "ended"', () => {
  it("rejects linkStatus 'ended'", () => {
    expect(SaveWorkerProfileSchema.safeParse({ ...base, linkStatus: 'ended' }).success).toBe(false);
  });

  it('accepts the field omitted entirely', () => {
    const { linkStatus: _omitted, ...noStatus } = base;
    expect(SaveWorkerProfileSchema.safeParse(noStatus).success).toBe(true);
  });
});

// #91: the modal caps max={today} client-side only, while the status flip is
// immediate — a last day weeks out zeroes HA/13th for weeks still worked.
describe('LastDaySchema (#91)', () => {
  const iso = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  it('rejects a future last day that the old one-year bound let through', () => {
    const r = TerminateContractorSchema.safeParse({ workerId: ID, lastDay: iso(30) });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]?.message).toBe('Last day cannot be in the future.');
  });

  it('accepts today and a past last day', () => {
    expect(TerminateContractorSchema.safeParse({ workerId: ID, lastDay: iso(0) }).success).toBe(
      true,
    );
    expect(TerminateContractorSchema.safeParse({ workerId: ID, lastDay: iso(-45) }).success).toBe(
      true,
    );
  });
});

describe('hireDateRangeError (#039)', () => {
  const thisYear = new Date().getUTCFullYear();
  it('rejects typos below 2000 and beyond next year', () => {
    expect(hireDateRangeError('1900-01-15')).toMatch(/between 2000/);
    expect(hireDateRangeError('2099-12-31')).toMatch(/between 2000/);
  });
  it('accepts a sane date (today) and a near-future hire', () => {
    expect(hireDateRangeError(`${thisYear}-06-15`)).toBeNull();
    expect(hireDateRangeError(`${thisYear + 1}-01-01`)).toBeNull();
  });
  it('flags a non-ISO string', () => {
    expect(hireDateRangeError('not-a-date')).toMatch(/ISO date/);
  });
});
