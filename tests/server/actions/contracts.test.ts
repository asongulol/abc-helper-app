/**
 * Contract versions, slices 2–4 (docs/CONTRACT-VERSIONS-PLAN.md §6): the
 * portal-login side effects of send and void, the draft bookkeeping, the
 * contractor's signature, and the countersign write-through.
 *
 * Send is what lets a departed contractor back in to sign — it restores the
 * login the sunset sweep revoked (or creates one) — so the two checks the plan
 * names are here: send restores a revoked login; void hands it back to the
 * sunset rule, and only then. Sign's checks: the signature row carries
 * doc_version=N and the sha256 of the frozen body; a second sign is rejected.
 * Countersign's checks (the money path): the rate lands at effective_from and
 * the prior one closes the day before; a rehire sets started_on and leaves the
 * old rate closed; a failure mid-way puts the rate back.
 */

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type Row, type Tables } from '../../fixtures/supabase-fake';

const W = '33333333-3333-4333-8333-333333333333';
const CO = '11111111-1111-4111-8111-111111111111';
const V2 = '44444444-4444-4444-8444-444444444444';

const world = vi.hoisted(() => ({ svc: null as unknown, payOutstanding: false, signer: '' }));
const portal = vi.hoisted(() => ({
  createPortalLogin: vi.fn(),
  restorePortalLogin: vi.fn(),
  revokePortalLogin: vi.fn(),
}));
const mail = vi.hoisted(() => ({
  trySend: vi.fn(async () => true),
  portalUrl: () => 'http://localhost:3000/portal',
}));

vi.mock('@/db/clients/service', () => ({ createServiceClient: () => world.svc }));
vi.mock('@/db/clients/server', () => ({
  createServerSupabase: async () => {
    throw new Error('reads that feed writes go through the service client');
  },
}));
vi.mock('@/server/auth/admin', () => ({
  getCurrentAdmin: async () => ({
    userId: 'admin-1',
    email: 'owner@abckidsny.com',
    companyIds: [],
    isOwner: true,
    canCountersign: true,
  }),
}));
vi.mock('@/server/audit', () => ({ logEvent: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/actions/portal-admin', () => portal);
vi.mock('@/server/email/send', () => mail);
vi.mock('@/db/queries/workers', () => ({ hasPayOutstanding: async () => world.payOutstanding }));
vi.mock('@/server/auth/worker', () => ({
  requireWorker: async () => ({ workerId: world.signer }),
}));
vi.mock('@/server/crypto', () => ({ encryptIfConfigured: async (s: string) => `enc:${s}` }));
vi.mock('@/db/queries/portal', () => ({
  fetchAgreementTemplate: async () => ({
    body: 'AGREEMENT with {{contractor_name}} for {{company_name}}. Compensation: {{rate}} from {{start_date}}.',
  }),
}));

const {
  countersignContractVersion,
  draftContractVersion,
  sendContractVersion,
  signContractVersion,
  voidContractVersion,
} = await import('@/server/actions/contracts');

const version = (over: Row = {}): Row => ({
  id: V2,
  worker_id: W,
  company_id: CO,
  version: 2,
  status: 'draft',
  rate_php: 25000,
  period_basis: 'semi_monthly',
  position: 'Senior VA',
  employment_type: 'FT',
  schedule: null,
  hours_per_week: 40,
  start_date: '2026-09-16',
  effective_from: '2026-09-16',
  addendum_type: null,
  addendum_text: null,
  supersedes_id: null,
  rendered_body: null,
  doc_sha256: null,
  sent_at: null,
  signed_at: null,
  ...over,
});

/** A departed contractor (rehire is the case that exercises every branch). */
const seed = (o: { worker?: Row; login?: Row | null; versions?: Row[] } = {}): Tables => ({
  workers: [
    {
      id: W,
      first_name: 'Ana',
      middle_name: null,
      last_name: 'Cruz',
      email: 'ana@example.ph',
      ph_address: 'Manila',
      status: 'ended',
      ...o.worker,
    },
  ],
  companies: [{ id: CO, name: 'Acme Clinic' }],
  worker_companies: [
    { worker_id: W, company_id: CO, contract: 'FT', role: 'VA', weekly_hours: 40, status: 'ended' },
  ],
  rates: [{ worker_id: W, company_id: CO, amount_php: 22000, effective_start: '2025-01-01' }],
  onboarding_agreements: [
    { worker_id: W, agreement_kind: 'ic_agreement', countersigner_name: 'Aaron Anderson' },
  ],
  onboarding_signatures: [
    {
      id: 'sig-1',
      worker_id: W,
      agreement_kind: 'ic_agreement',
      doc_version: '1',
      status: 'signed',
      signed_at: '2024-01-10T09:00:00Z',
    },
  ],
  contractor_logins:
    o.login === null
      ? []
      : [{ worker_id: W, email: 'ana@example.ph', status: 'revoked', ...o.login }],
  contract_versions: o.versions ?? [version()],
});

const first = (tables: Tables): Row => (tables.contract_versions ?? [])[0] as Row;

const boot = (tables: Tables) => {
  const fake = fakeSupabase(tables);
  world.svc = fake.client;
  return fake.tables;
};

beforeEach(() => {
  vi.clearAllMocks();
  world.payOutstanding = false;
  world.signer = W;
  portal.createPortalLogin.mockResolvedValue({ ok: true, data: {} });
  portal.restorePortalLogin.mockResolvedValue({ ok: true });
  portal.revokePortalLogin.mockResolvedValue({ ok: true });
});

describe('sendContractVersion', () => {
  it('freezes the document, restores the revoked login, and emails the notice', async () => {
    const tables = boot(seed());

    const res = await sendContractVersion({ versionId: V2 });

    expect(res).toEqual({ ok: true, data: { emailSent: true, login: 'restored' } });
    expect(portal.restorePortalLogin).toHaveBeenCalledWith({ workerId: W });
    expect(portal.createPortalLogin).not.toHaveBeenCalled();

    const row = first(tables);
    expect(row.status).toBe('sent');
    expect(row.sent_at).toBeTruthy();
    const body = row.rendered_body as string;
    expect(body).toContain('AGREEMENT with Ana Cruz for Acme Clinic');
    expect(body).toContain('Compensation: 25,000.00 per semi-monthly period from 2026-09-16');
    // The one merge line every version carries (decision 12): effective date +
    // the agreement it supersedes, dated by the v1 read-through's signature.
    expect(body).toContain(
      'This Agreement takes effect on 2026-09-16 and supersedes the Independent Contractor Agreement dated 2024-01-10.',
    );
    // The hash the signature row will carry (slice 3) is of exactly this text.
    expect(row.doc_sha256).toBe(createHash('sha256').update(body).digest('hex'));

    const [to, subject, html, context] = mail.trySend.mock.calls[0] as string[];
    expect(to).toBe('ana@example.ph');
    expect(subject).toMatch(/ready to sign/);
    expect(html).toContain('version 2');
    expect(html).toContain('2026-09-16');
    expect(context).toBe('contract_review');
  });

  it('creates a login from the profile email when there is none', async () => {
    boot(seed({ login: null }));

    const res = await sendContractVersion({ versionId: V2 });

    expect(res).toMatchObject({ ok: true, data: { login: 'created' } });
    expect(portal.createPortalLogin).toHaveBeenCalledWith({ workerId: W, email: 'ana@example.ph' });
    expect(portal.restorePortalLogin).not.toHaveBeenCalled();
  });

  it('leaves an active login alone', async () => {
    boot(seed({ login: { status: 'active' } }));

    const res = await sendContractVersion({ versionId: V2 });

    expect(res).toMatchObject({ ok: true, data: { login: 'active' } });
    expect(portal.restorePortalLogin).not.toHaveBeenCalled();
    expect(portal.createPortalLogin).not.toHaveBeenCalled();
  });

  it('sends only a draft', async () => {
    const tables = boot(seed({ versions: [version({ status: 'sent', sent_at: 'earlier' })] }));

    const res = await sendContractVersion({ versionId: V2 });

    expect(res).toMatchObject({ ok: false, error: /only a draft/ });
    expect(first(tables).rendered_body).toBeNull();
    expect(portal.restorePortalLogin).not.toHaveBeenCalled();
    expect(mail.trySend).not.toHaveBeenCalled();
  });
});

describe('voidContractVersion', () => {
  const sent = () => version({ status: 'sent', sent_at: '2026-09-01T00:00:00Z' });

  it('re-revokes the login send restored when the departure is fully paid', async () => {
    const tables = boot(seed({ login: { status: 'active' }, versions: [sent()] }));

    const res = await voidContractVersion({ versionId: V2, reason: 'wrong rate' });

    expect(res).toEqual({ ok: true, data: { loginRevoked: true } });
    expect(portal.revokePortalLogin).toHaveBeenCalledWith({ workerId: W });
    const row = first(tables);
    expect(row).toMatchObject({ status: 'void', void_reason: 'wrong rate' });
    expect(row.voided_at).toBeTruthy();
  });

  it('keeps the login while pay is still outstanding — the sunset rule', async () => {
    world.payOutstanding = true;
    boot(seed({ login: { status: 'active' }, versions: [sent()] }));

    const res = await voidContractVersion({ versionId: V2 });

    expect(res).toEqual({ ok: true, data: { loginRevoked: false } });
    expect(portal.revokePortalLogin).not.toHaveBeenCalled();
  });

  it('never touches the login of a contractor who is still working', async () => {
    boot(seed({ worker: { status: 'active' }, login: { status: 'active' }, versions: [sent()] }));

    const res = await voidContractVersion({ versionId: V2 });

    expect(res).toEqual({ ok: true, data: { loginRevoked: false } });
    expect(portal.revokePortalLogin).not.toHaveBeenCalled();
  });

  it('supersedes the signature on a signed version, and only that one', async () => {
    const tables = boot(seed({ versions: [version({ status: 'signed' })] }));
    tables.onboarding_signatures?.push({
      id: 'sig-2',
      worker_id: W,
      agreement_kind: 'ic_agreement',
      doc_version: '2',
      status: 'signed',
    });

    const res = await voidContractVersion({ versionId: V2 });

    expect(res.ok).toBe(true);
    const byVersion = Object.fromEntries(
      (tables.onboarding_signatures ?? []).map((s) => [s.doc_version, s.status]),
    );
    expect(byVersion).toEqual({ '1': 'signed', '2': 'superseded' });
  });

  it('cannot void the contract of record', async () => {
    const tables = boot(seed({ versions: [version({ status: 'active' })] }));

    const res = await voidContractVersion({ versionId: V2 });

    expect(res).toMatchObject({ ok: false, error: /cannot be voided/ });
    expect(first(tables).status).toBe('active');
  });
});

describe('draftContractVersion', () => {
  const terms = {
    workerId: W,
    companyId: CO,
    ratePhp: 30000,
    position: 'Lead VA',
    employmentType: 'FT',
    schedule: null,
    hoursPerWeek: 40,
    startDate: '2026-10-01',
    effectiveFrom: '2026-10-01',
    addendumType: '',
    addendumText: null,
  };

  it('numbers a new draft after the latest version and points it at the version of record', async () => {
    const tables = boot(
      seed({
        versions: [
          version({ id: 'v-2', version: 2, status: 'active' }),
          version({ id: 'v-3', version: 3, status: 'void' }),
        ],
      }),
    );

    const res = await draftContractVersion(terms);

    expect(res).toMatchObject({ ok: true, data: { version: 4 } });
    const drafted = (tables.contract_versions ?? []).find((v) => v.version === 4);
    expect(drafted).toMatchObject({
      status: 'draft',
      supersedes_id: 'v-2',
      rate_php: 30000,
      position: 'Lead VA',
      created_by: 'admin-1',
    });
  });

  it('starts at version 2 with nothing to point at when the record is the v1 read-through', async () => {
    const tables = boot(seed({ versions: [] }));

    const res = await draftContractVersion(terms);

    expect(res).toMatchObject({ ok: true, data: { version: 2 } });
    expect(tables.contract_versions?.[0]).toMatchObject({ version: 2, supersedes_id: null });
  });

  it('edits the existing draft in place — drafts are free', async () => {
    const tables = boot(seed());

    const res = await draftContractVersion(terms);

    expect(res).toMatchObject({ ok: true, data: { versionId: V2, version: 2 } });
    expect(tables.contract_versions).toHaveLength(1);
    expect(tables.contract_versions?.[0]).toMatchObject({ rate_php: 30000, position: 'Lead VA' });
  });

  it('refuses while a version is out for signature', async () => {
    const tables = boot(seed({ versions: [version({ status: 'sent' })] }));

    const res = await draftContractVersion(terms);

    expect(res).toMatchObject({ ok: false, error: /out for signature/ });
    expect(tables.contract_versions).toHaveLength(1);
  });

  it('rejects an effective date before the start date', async () => {
    boot(seed({ versions: [] }));

    const res = await draftContractVersion({ ...terms, effectiveFrom: '2026-09-30' });

    expect(res).toMatchObject({ ok: false, error: /before the start date/ });
  });
});

describe('signContractVersion', () => {
  const BODY = 'AGREEMENT frozen at send.';
  const SHA = createHash('sha256').update(BODY).digest('hex');
  const sent = (over: Row = {}) =>
    version({
      status: 'sent',
      sent_at: '2026-09-01T00:00:00Z',
      rendered_body: BODY,
      doc_sha256: SHA,
      ...over,
    });
  const sigs = (tables: Tables) => tables.onboarding_signatures ?? [];
  const input = { versionId: V2, signatureDataUrl: '', typedName: 'Ana Cruz', scrolledToEnd: true };

  it('records the signature against the version number and the frozen body hash', async () => {
    const tables = boot(seed({ versions: [sent()] }));

    const res = await signContractVersion(input);

    expect(res).toEqual({ ok: true });
    expect(sigs(tables)).toHaveLength(2);
    expect(sigs(tables)[1]).toMatchObject({
      worker_id: W,
      agreement_kind: 'ic_agreement',
      doc_version: '2',
      doc_sha256: SHA,
      signed_legal_name: 'Ana Cruz',
      signature_method: 'typed',
      signature_data: null,
      scrolled_to_end: true,
      status: 'signed',
    });
    expect(first(tables).status).toBe('signed');
    expect(first(tables).signed_at).toBeTruthy();
  });

  it('stores a drawn signature encrypted, like signAgreement', async () => {
    const tables = boot(seed({ versions: [sent()] }));

    const res = await signContractVersion({
      ...input,
      signatureDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    });

    expect(res).toEqual({ ok: true });
    expect(sigs(tables)[1]).toMatchObject({
      signature_method: 'drawn',
      signature_data: 'enc:data:image/png;base64,iVBORw0KGgo=',
    });
  });

  it('rejects a second signature instead of absorbing it', async () => {
    const tables = boot(seed({ versions: [sent({ status: 'signed' })] }));

    const res = await signContractVersion(input);

    expect(res).toMatchObject({ ok: false, error: /already signed/ });
    expect(sigs(tables)).toHaveLength(1);
  });

  it('refuses without the scroll-to-end evidence', async () => {
    const tables = boot(seed({ versions: [sent()] }));

    const res = await signContractVersion({ ...input, scrolledToEnd: false });

    expect(res).toMatchObject({ ok: false, error: /Scroll through/ });
    expect(sigs(tables)).toHaveLength(1);
    expect(first(tables).status).toBe('sent');
  });

  it("does not sign another contractor's version", async () => {
    world.signer = '99999999-9999-4999-8999-999999999999';
    const tables = boot(seed({ versions: [sent()] }));

    const res = await signContractVersion(input);

    expect(res).toMatchObject({ ok: false, error: /not found/ });
    expect(sigs(tables)).toHaveLength(1);
    expect(first(tables).status).toBe('sent');
  });
});

describe('countersignContractVersion', () => {
  const V3 = '55555555-5555-4555-8555-555555555555';
  const signed = (over: Row = {}) =>
    version({
      id: V3,
      version: 3,
      status: 'signed',
      supersedes_id: V2,
      rate_php: 25000,
      hours_per_week: 32,
      start_date: '2025-01-01',
      effective_from: '2026-09-16',
      sent_at: '2026-09-01T00:00:00Z',
      signed_at: '2026-09-02T00:00:00Z',
      ...over,
    });
  const byId = (tables: Tables, id: string) =>
    (tables.contract_versions ?? []).find((v) => v.id === id) as Row;
  const rates = (tables: Tables) =>
    [...(tables.rates ?? [])].sort((a, b) =>
      String(a.effective_start).localeCompare(String(b.effective_start)),
    );

  /** A current contractor on version 2, being moved to version 3 (a raise). */
  const current = () => {
    const tables = boot(
      seed({
        worker: { status: 'active' },
        login: { status: 'active' },
        versions: [version({ status: 'active', effective_from: '2025-01-01' }), signed()],
      }),
    );
    tables.worker_companies = [
      {
        worker_id: W,
        company_id: CO,
        contract: 'PT',
        role: 'VA',
        weekly_hours: 20,
        status: 'active',
        started_on: '2025-01-01',
        ended_on: null,
      },
    ];
    tables.rates = [
      {
        id: 'r-1',
        worker_id: W,
        company_id: CO,
        amount_php: 22000,
        effective_start: '2025-01-01',
        effective_end: null,
      },
    ];
    return tables;
  };

  /** A departed contractor whose version 2 termination ended, being rehired on version 3. */
  const departed = () => {
    const tables = boot(
      seed({
        versions: [
          version({ status: 'ended', effective_from: '2025-01-01', ended_on: '2026-06-30' }),
          signed({ start_date: '2026-09-16' }),
        ],
      }),
    );
    tables.worker_companies = [
      {
        worker_id: W,
        company_id: CO,
        contract: 'FT',
        role: 'VA',
        weekly_hours: 40,
        status: 'ended',
        started_on: '2025-01-01',
        ended_on: '2026-06-30',
      },
    ];
    tables.rates = [
      {
        id: 'r-1',
        worker_id: W,
        company_id: CO,
        amount_php: 22000,
        effective_start: '2025-01-01',
        effective_end: '2026-06-30',
      },
    ];
    return tables;
  };

  it('writes the rate at effective_from, closes the prior one the day before, and makes the version of record', async () => {
    const tables = current();

    const res = await countersignContractVersion({ versionId: V3 });

    expect(res).toEqual({ ok: true, data: { emailSent: true, rehired: false } });
    expect(rates(tables)).toEqual([
      expect.objectContaining({ id: 'r-1', amount_php: 22000, effective_end: '2026-09-15' }),
      expect.objectContaining({ amount_php: 25000, effective_start: '2026-09-16' }),
    ]);
    expect(rates(tables)[1]?.effective_end).toBeUndefined();
    // The engagement carries the version's terms; nothing about its dates moved.
    expect(tables.worker_companies?.[0]).toMatchObject({
      contract: 'FT',
      role: 'Senior VA',
      weekly_hours: 32,
      status: 'active',
      started_on: '2025-01-01',
      ended_on: null,
    });
    expect(byId(tables, V2)).toMatchObject({ status: 'superseded', ended_on: '2026-09-15' });
    expect(byId(tables, V3)).toMatchObject({
      status: 'active',
      countersigned_by: 'admin-1',
      countersigned_name: 'owner@abckidsny.com',
    });
    expect(byId(tables, V3).countersigned_at).toBeTruthy();

    const [to, subject, html, context] = mail.trySend.mock.calls[0] as string[];
    expect(to).toBe('ana@example.ph');
    expect(subject).toMatch(/countersigned/);
    expect(html).toContain(`http://localhost:3000/portal/contracts/${V3}/print`);
    expect(html).toContain('2026-09-16');
    expect(context).toBe('contract_countersigned');
  });

  it('rehire: reopens the engagement from the new start date and leaves the old rate closed', async () => {
    const tables = departed();

    const res = await countersignContractVersion({ versionId: V3 });

    expect(res).toEqual({ ok: true, data: { emailSent: true, rehired: true } });
    expect(tables.worker_companies?.[0]).toMatchObject({
      status: 'active',
      started_on: '2026-09-16',
      ended_on: null,
    });
    expect(tables.workers?.[0]?.status).toBe('active');
    // Decision 7: the old closed rate stays closed on its real last day; the
    // new version writes its own. reactivateWorkerLink would have reopened it.
    expect(rates(tables)).toEqual([
      expect.objectContaining({ id: 'r-1', effective_end: '2026-06-30' }),
      expect.objectContaining({ amount_php: 25000, effective_start: '2026-09-16' }),
    ]);
    // The ended version keeps the termination date — it is evidence, and the
    // contractor was not under contract between the two.
    expect(byId(tables, V2)).toMatchObject({ status: 'ended', ended_on: '2026-06-30' });
    expect(byId(tables, V3).status).toBe('active');
  });

  it('countersigns only a signed version', async () => {
    const tables = current();
    byId(tables, V3).status = 'sent';

    const res = await countersignContractVersion({ versionId: V3 });

    expect(res).toMatchObject({ ok: false, error: /only a signed version/ });
    expect(rates(tables)).toHaveLength(1);
    expect(byId(tables, V2).status).toBe('active');
  });

  it('puts the rate back when a later step fails', async () => {
    const tables = current();
    // Fail the engagement write (step 2), after the rate (step 1) has landed.
    const real = world.svc as { from: (t: string) => Record<string, unknown> };
    world.svc = {
      from: (t: string) => {
        const q = real.from(t);
        if (t === 'worker_companies')
          q.update = () => {
            throw new Error('worker_companies is on fire');
          };
        return q;
      },
    };

    const res = await countersignContractVersion({ versionId: V3 });

    expect(res).toMatchObject({ ok: false, error: /on fire/ });
    expect(rates(tables)).toEqual([
      expect.objectContaining({ id: 'r-1', amount_php: 22000, effective_end: null }),
    ]);
    expect(byId(tables, V2).status).toBe('active');
    expect(byId(tables, V3).status).toBe('signed');
    expect(byId(tables, V3).countersigned_at).toBeUndefined();
    expect(mail.trySend).not.toHaveBeenCalled();
  });
});
