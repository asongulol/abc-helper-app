/**
 * signAgreement's re-sign path (docs/CONTRACT-CHANGE-WIZARD-PLAN.md decision 8):
 * a kind the package superseded is signed again, filed under the contract
 * version that asked for it, contract first and in order — and the fresh
 * signature does not reopen a finished onboarding.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type Row, type Tables } from '../../fixtures/supabase-fake';

const W = '33333333-3333-4333-8333-333333333333';
const CO = '11111111-1111-4111-8111-111111111111';

const world = vi.hoisted(() => ({ svc: null as unknown }));
const payroll = vi.hoisted(() => ({
  syncPackageHolds: vi.fn(async () => ({ held: 0, lifted: 1 })),
}));

vi.mock('@/db/clients/service', () => ({ createServiceClient: () => world.svc }));
vi.mock('@/db/clients/server', () => ({
  createServerSupabase: async () => {
    throw new Error('signAgreement writes through the service client');
  },
}));
vi.mock('@/server/auth/worker', () => ({ requireWorker: async () => ({ workerId: W }) }));
vi.mock('@/server/auth/admin', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/server/company', () => ({ getEmployerCompanyId: vi.fn() }));
vi.mock('@/server/audit', () => ({ logEvent: vi.fn(), logWorkerEvent: vi.fn() }));
vi.mock('@/server/crypto', () => ({
  encryptIfConfigured: async (s: string) => `enc:${s}`,
  decryptIfNeeded: async (s: string) => s,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/payroll', () => payroll);

const { signAgreement } = await import('@/server/actions/portal');

const sig = (id: string, kind: string, status: string, docVersion = '1'): Row => ({
  id,
  worker_id: W,
  agreement_kind: kind,
  doc_version: docVersion,
  status,
  signed_at: '2024-01-10T09:00:00Z',
});

const seed = (
  o: { versionStatus?: string; kinds?: string[]; superseded?: string[] } = {},
): Tables => {
  const superseded = new Set(o.superseded ?? ['confidentiality_nda']);
  return {
    onboarding_signatures: ['ic_agreement', 'non_compete', 'confidentiality_nda', 'baa'].map((k) =>
      sig(`sig-${k}`, k, superseded.has(k) ? 'superseded' : 'signed'),
    ),
    onboarding_progress: [
      {
        worker_id: W,
        current_stage: 'complete',
        completed_at: '2025-01-01T00:00:00Z',
        stage1_complete: true,
      },
    ],
    contract_versions: [
      {
        id: 'v-2',
        worker_id: W,
        company_id: CO,
        version: 2,
        status: o.versionStatus ?? 'signed',
        resign_kinds: o.kinds ?? ['confidentiality_nda'],
        resign_due_on: '2026-09-30',
        sent_at: '2026-09-08T00:00:00Z',
      },
    ],
  };
};

const boot = (tables: Tables) => {
  const fake = fakeSupabase(tables);
  world.svc = fake.client;
  return fake.tables;
};

const input = { signatureDataUrl: '', typedName: 'Ana Cruz', scrolledToEnd: true };

beforeEach(() => vi.clearAllMocks());

describe('signAgreement — re-sign', () => {
  it('files the fresh signature under the version, keeps onboarding complete, syncs the hold', async () => {
    const tables = boot(seed());

    const res = await signAgreement({ agreementKey: 'confidentiality_nda', ...input });

    expect(res).toEqual({ ok: true });
    const nda = (tables.onboarding_signatures ?? []).filter(
      (s) => s.agreement_kind === 'confidentiality_nda',
    );
    expect(nda.map((s) => [s.doc_version, s.status])).toEqual([
      ['1', 'superseded'],
      ['2', 'signed'],
    ]);
    expect(tables.onboarding_progress?.[0]).toMatchObject({
      stage1_complete: true,
      current_stage: 'complete',
    });
    expect(payroll.syncPackageHolds).toHaveBeenCalledWith({ workerIds: [W] }, expect.anything());
  });

  it('the contract comes first', async () => {
    const tables = boot(seed({ versionStatus: 'sent' }));

    const res = await signAgreement({ agreementKey: 'confidentiality_nda', ...input });

    expect(res).toMatchObject({ ok: false, error: /contractor agreement first/ });
    expect(tables.onboarding_signatures).toHaveLength(4);
    expect(payroll.syncPackageHolds).not.toHaveBeenCalled();
  });

  it('then the package in order — a superseded earlier kind blocks the later one', async () => {
    boot(
      seed({
        kinds: ['non_compete', 'confidentiality_nda'],
        superseded: ['non_compete', 'confidentiality_nda'],
      }),
    );

    const res = await signAgreement({ agreementKey: 'confidentiality_nda', ...input });

    expect(res).toMatchObject({ ok: false, error: /in order/ });
  });
});
