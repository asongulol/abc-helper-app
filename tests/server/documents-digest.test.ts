/**
 * runHiringReviewCheck — the digest sends when ONLY chase items exist (no docs
 * awaiting review), merges a contractor engaged at two companies into one entry,
 * and stays silent when there is nothing at all.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  sent: [] as { to: string; subject: string; html: string }[],
  team: {} as Record<string, { workerId: string; workerName: string; items: unknown[] }[]>,
}));

vi.mock('@/db/clients/service', () => ({ createServiceClient: () => ({}) }));
vi.mock('@/server/env', () => ({ env: { GMAIL_USER: 'hr@example.com' } }));
vi.mock('@/db/queries/documents', () => ({
  fetchDocumentsForExpiryCheck: vi.fn(),
  fetchDocumentsForHiringReview: async () => [],
}));
vi.mock('@/db/queries/config', () => ({
  getPortalSettings: vi.fn(),
  parseOnboardingConfig: vi.fn(),
  listCompaniesFull: async () => [
    { id: 'c1', name: 'Acme' },
    { id: 'c2', name: 'Bolt' },
  ],
}));
vi.mock('@/db/queries/onboarding', () => ({
  fetchCurrentTeam: async (_db: unknown, companyId: string) => world.team[companyId] ?? [],
}));
vi.mock('@/server/email/transport', () => ({
  sendEmail: async (m: { to: string; subject: string; html: string }) => {
    world.sent.push(m);
    return { ok: true };
  },
}));

const { runHiringReviewCheck } = await import('@/server/documents/service');

const item = (kind: string, label: string, owed: string[] = []) => ({
  kind,
  label,
  tone: 'warn',
  owed,
});

beforeEach(() => {
  world.sent = [];
  world.team = {};
});

describe('runHiringReviewCheck — outstanding contracts & requested docs', () => {
  it('emails when only chase items exist and merges a two-company contractor', async () => {
    world.team = {
      c1: [
        {
          workerId: 'w1',
          workerName: 'Lea',
          items: [item('sent', 'Contract sent · 3 days', ['Sign'])],
        },
        { workerId: 'w2', workerName: 'Ana', items: [item('doc_review', '1 document to review')] },
      ],
      c2: [
        {
          workerId: 'w1',
          workerName: 'Lea',
          items: [item('doc_requested', '1 requested document outstanding', ['Upload: TIN ID'])],
        },
      ],
    };
    const r = await runHiringReviewCheck();
    expect(r.pendingDocs).toBe(0);
    expect(r.outstanding).toEqual([
      { worker: 'Lea', company: 'Acme, Bolt', lines: ['Contract sent · 3 days', 'Upload: TIN ID'] },
    ]);
    expect(r.emailed).toBe(true);
    expect(world.sent[0]?.subject).toBe('Onboarding & contracts: 2 to chase');
    expect(world.sent[0]?.html).toContain('Contracts &amp; requested documents to chase (2)');
    expect(world.sent[0]?.html).toContain('Upload: TIN ID');
    expect(world.sent[0]?.html).not.toContain('Waiting for review');
  });

  it('stays silent when nothing is pending or outstanding', async () => {
    const r = await runHiringReviewCheck();
    expect(r.outstanding).toEqual([]);
    expect(r.emailed).toBe(false);
    expect(world.sent).toEqual([]);
  });
});
