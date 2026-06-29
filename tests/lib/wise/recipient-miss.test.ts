import { describe, expect, it } from 'vitest';
import { missingRecipientReason } from '@/lib/wise/recipient-miss';

describe('missingRecipientReason — stale id vs systemic config problem', () => {
  it('flags a credential/environment problem when the profile sees 0 recipients', () => {
    const msg = missingRecipientReason(2007678887, 0);
    expect(msg).toMatch(/wrong[\s\S]*Wise account or environment/i);
    expect(msg).toContain('WISE_API_TOKEN');
  });

  it('treats the id as stale/deleted when the profile has other recipients', () => {
    const msg = missingRecipientReason(2007678887, 12);
    expect(msg).toMatch(/deleted or re-created/i);
    expect(msg).toContain('12'); // names the count so the admin can sanity-check
  });

  it('falls back to the config-problem message for a negative/unknown count', () => {
    expect(missingRecipientReason(1, -1)).toMatch(/0 recipients/);
  });
});
