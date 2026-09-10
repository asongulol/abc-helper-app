/**
 * serviceVerifyRecipients — a Wisetag contact saved WITHOUT its UUID (the
 * legacy panel stripped them) must verify via the contacts list by numeric id,
 * not read as "missing" because GET /v1/accounts/{id} 403s for Wisetags.
 */

import { describe, expect, it, vi } from 'vitest';
import { fakeWise } from '../../fixtures/wise-fake';

// service.ts → client.ts reads env at import; the fake api means no fetch runs.
vi.mock('@/server/env', () => ({ env: { WISE_API_TOKEN: 'test-token' } }));

const { serviceVerifyRecipients } = await import('@/server/wise/service');

const api = fakeWise({
  contacts: [
    { uuid: '80d120ce-0000-4000-8000-000000000000', recipientId: 1240570134, name: 'Vince' },
  ],
});

describe('serviceVerifyRecipients', () => {
  it('matches a UUID-less Wisetag contact by numeric id', async () => {
    const [bank, tag] = await serviceVerifyRecipients(
      [
        { id: 1566509349, uuid: '82194c64-0000-4000-8000-000000000000', label: 'Bank' },
        { id: 1240570134, uuid: null, label: 'Wisetag' },
      ],
      api,
    );
    expect(bank?.status).toBe('missing'); // bank UUID isn't a contact; id not in fake recipients
    expect(tag?.status).toBe('ok');
    expect(tag?.detail).toContain('80d120ce');
  });

  it('still reports a truly unknown id as missing', async () => {
    const [r] = await serviceVerifyRecipients([{ id: 42, uuid: null, label: 'Gone' }], api);
    expect(r?.status).toBe('missing');
  });
});
