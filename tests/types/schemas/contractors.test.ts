import { describe, expect, it } from 'vitest';
import { SaveWorkerProfileSchema } from '@/types/schemas/contractors';

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
});
