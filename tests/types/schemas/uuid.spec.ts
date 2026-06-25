import { describe, expect, it } from 'vitest';
import { SetLinkStatusSchema } from '@/types/schemas/contractors';
import { uuid } from '@/types/schemas/uuid';

// A real shared-prod worker id shape: 8-4-4-4-12 hex but NOT RFC-4122-compliant
// (version/variant nibbles are 0). Zod v4's .uuid() rejects these ("Invalid UUID").
const SEEDED = 'a0000000-0000-0000-0000-000000000022';
const REAL = 'e3b16441-8aee-4506-937f-135152f892a3';

describe('uuid() id validator', () => {
  it('accepts seeded non-RFC shared-prod ids (which Zod v4 .uuid() rejects)', () => {
    expect(uuid().safeParse(SEEDED).success).toBe(true);
    expect(uuid().safeParse(REAL).success).toBe(true);
  });

  it('still rejects non-uuid-shaped strings', () => {
    expect(uuid().safeParse('nope').success).toBe(false);
    expect(uuid().safeParse('a0000000-0000-0000-0000').success).toBe(false);
    expect(uuid().safeParse('').success).toBe(false);
  });

  it('SetLinkStatusSchema accepts a seeded worker/company id (the profile-save bug)', () => {
    const r = SetLinkStatusSchema.safeParse({
      workerId: SEEDED,
      companyId: SEEDED,
      active: true,
    });
    expect(r.success).toBe(true);
  });
});
