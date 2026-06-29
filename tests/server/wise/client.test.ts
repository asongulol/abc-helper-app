import { afterEach, describe, expect, it, vi } from 'vitest';

// client.ts reads env.WISE_API_TOKEN via getToken(); give it a token so the
// request path runs without throwing the "not set" guard.
vi.mock('@/server/env', () => ({ env: { WISE_API_TOKEN: 'test-token' } }));

import { wiseRequestNullable } from '@/server/wise/client';

const stubFetch = (status: number, body: string) =>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wiseRequestNullable — absent recipient resolves to null', () => {
  it('returns null on a plain 404', async () => {
    stubFetch(404, '');
    expect(await wiseRequestNullable('/v1/accounts/1')).toBeNull();
  });

  it('returns null on 403 RECIPIENT_MISSING (deleted / stale / foreign id)', async () => {
    // The exact shape Wise returns for an id no longer among your recipients.
    stubFetch(
      403,
      JSON.stringify({ errors: [{ code: 'RECIPIENT_MISSING', message: 'not found' }] }),
    );
    expect(await wiseRequestNullable('/v1/accounts/2007678887')).toBeNull();
  });

  it('still throws on a 403 that is a real auth failure (not RECIPIENT_MISSING)', async () => {
    stubFetch(403, JSON.stringify({ error: 'forbidden' }));
    await expect(wiseRequestNullable('/v1/accounts/1')).rejects.toThrow(/403/);
  });

  it('returns the parsed body on success', async () => {
    stubFetch(200, JSON.stringify({ id: 123, name: 'Acme' }));
    expect(await wiseRequestNullable('/v1/accounts/123')).toEqual({ id: 123, name: 'Acme' });
  });
});
