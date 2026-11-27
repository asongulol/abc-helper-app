import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/env', () => ({ env: {} }));
vi.mock('@/db/clients/service', () => ({ createServiceClient: vi.fn() }));

import { fetchMemberNames } from '@/server/hubstaff/client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMemberNames', () => {
  it('resolves a user with hours who is no longer in the member list', async () => {
    // Member list holds only user 1; user 4643025 tracked time, then left the org.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/members')) {
        return new Response(JSON.stringify({ members: [{ user_id: 1 }] }));
      }
      const ids = [...url.matchAll(/id%5B%5D=(\d+)/g)].map((m) => Number(m[1]));
      const names: Record<number, string> = { 1: 'Ann Member', 4643025: 'Ma Kaye Flor' };
      return new Response(JSON.stringify({ users: ids.map((id) => ({ id, name: names[id] })) }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const withoutExtras = await fetchMemberNames(258598, 'tok');
    expect(withoutExtras.has(4643025)).toBe(false);

    const names = await fetchMemberNames(258598, 'tok', [4643025, 1]);
    expect(names.get(4643025)).toBe('Ma Kaye Flor');
    expect(names.get(1)).toBe('Ann Member');
    expect(names.size).toBe(2);
  });
});
