import { describe, expect, it } from 'vitest';
import { CompanyFieldsSchema } from '@/types/schemas/config';

describe('CompanyFieldsSchema — Finding #016.3 human error message', () => {
  it('rejects a non-positive Hubstaff org ID with a friendly message', () => {
    const r = CompanyFieldsSchema.safeParse({
      name: 'Aaron Anderson E.H.S. LLC',
      hubstaffOrgId: -5,
    });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]?.message).toBe(
      'Hubstaff org ID must be a positive number.',
    );
  });

  it('accepts a positive Hubstaff org ID', () => {
    expect(
      CompanyFieldsSchema.safeParse({ name: 'Aaron Anderson E.H.S. LLC', hubstaffOrgId: 12345 })
        .success,
    ).toBe(true);
  });

  it('accepts a null Hubstaff org ID', () => {
    expect(
      CompanyFieldsSchema.safeParse({ name: 'Aaron Anderson E.H.S. LLC', hubstaffOrgId: null })
        .success,
    ).toBe(true);
  });
});
