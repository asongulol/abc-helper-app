import { describe, expect, it } from 'vitest';
import {
  LinkWiseRecipientSchema,
  SaveWiseRecipientsSchema,
  SaveWiseRecipientUuidSchema,
} from '@/types/schemas/wise-recipients';

// Shared prod seeds non-RFC ids like this; uuid() must accept them (see PR #15).
const PROD_ID = 'a0000000-0000-0000-0000-000000000022';

describe('wise-recipients schemas', () => {
  it('accepts non-RFC seeded prod ids on save-recipients', () => {
    const r = SaveWiseRecipientsSchema.safeParse({
      workerId: PROD_ID,
      companyId: PROD_ID,
      recipients: [{ id: 123, label: 'BPI peso' }],
      defaultId: 123,
    });
    expect(r.success).toBe(true);
  });

  it('allows an empty recipients list with a null default', () => {
    const r = SaveWiseRecipientsSchema.safeParse({
      workerId: PROD_ID,
      companyId: PROD_ID,
      recipients: [],
      defaultId: null,
    });
    expect(r.success).toBe(true);
  });

  it('rejects a non-positive recipient id', () => {
    const r = SaveWiseRecipientsSchema.safeParse({
      workerId: PROD_ID,
      companyId: PROD_ID,
      recipients: [{ id: 0, label: 'x' }],
      defaultId: null,
    });
    expect(r.success).toBe(false);
  });

  it('allows a null UUID (clears it)', () => {
    const r = SaveWiseRecipientUuidSchema.safeParse({
      workerId: PROD_ID,
      companyId: PROD_ID,
      recipientUuid: null,
    });
    expect(r.success).toBe(true);
  });

  it('requires applyName/applyEmail/fromContact booleans on link', () => {
    const ok = LinkWiseRecipientSchema.safeParse({
      workerId: PROD_ID,
      companyId: PROD_ID,
      recipientId: 5,
      name: 'Juan Cruz',
      email: null,
      applyName: true,
      applyEmail: false,
      fromContact: false,
    });
    expect(ok.success).toBe(true);

    const bad = LinkWiseRecipientSchema.safeParse({
      workerId: PROD_ID,
      companyId: PROD_ID,
      recipientId: 5,
      name: 'Juan Cruz',
      email: null,
      applyName: 'yes',
      applyEmail: false,
      fromContact: false,
    });
    expect(bad.success).toBe(false);
  });
});
