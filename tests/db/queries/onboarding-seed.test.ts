/**
 * seedAgreementPrefill — derives the hire wizard's agreement prefill from rows
 * a worker already has, for contractors added outside the wizard. The things
 * that must hold: engagement terms land on the IC Agreement only, the
 * assignment carrying the current rate wins over other active links, and an
 * already-prepared worker is left untouched.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@/db/types';

// queries/onboarding imports crypto, which validates server env at import time.
vi.mock('@/server/crypto', () => ({ decryptIfNeeded: vi.fn() }));
const { seedAgreementPrefill } = await import('@/db/queries/onboarding');

type World = {
  existingAgreements: { worker_id: string }[];
  worker: { hire_date: string | null } | null;
  links: {
    company_id: string;
    role: string | null;
    contract: string | null;
    weekly_hours: number | null;
    companies: { name: string } | null;
  }[];
  rate: { amount_php: number; period_basis: string; company_id: string } | null;
};

/** Minimal thenable builder stub: answers per table, records upserted rows. */
const stub = (world: World) => {
  const upserts: Record<string, unknown>[][] = [];
  const from = (table: string) => {
    let isUpsert = false;
    const answer = () => {
      if (table === 'onboarding_agreements')
        return isUpsert
          ? { data: null, error: null }
          : { data: world.existingAgreements, error: null };
      if (table === 'worker_companies') return { data: world.links, error: null };
      throw new Error(`unexpected table ${table}`);
    };
    const b = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      upsert: (rows: Record<string, unknown>[]) => {
        isUpsert = true;
        upserts.push(rows);
        return b;
      },
      maybeSingle: () =>
        Promise.resolve(
          table === 'workers'
            ? { data: world.worker, error: null }
            : { data: world.rate, error: null },
        ),
      // biome-ignore lint/suspicious/noThenProperty: a supabase query builder is awaitable at every step — that is the thing being stubbed
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve),
    };
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, upserts };
};

describe('seedAgreementPrefill', () => {
  it('seeds all 4 kinds from the rate-bearing assignment; terms on IC only', async () => {
    const { db, upserts } = stub({
      existingAgreements: [],
      worker: { hire_date: '2026-05-13' },
      links: [
        {
          company_id: 'A',
          role: 'DB Specialist',
          contract: 'PT',
          weekly_hours: 20,
          companies: { name: 'Ability' },
        },
        {
          company_id: 'B',
          role: 'QA Specialist',
          contract: 'PT',
          weekly_hours: 20,
          companies: { name: 'Aaron' },
        },
      ],
      rate: { amount_php: 15000, period_basis: 'semi_monthly', company_id: 'B' },
    });
    await seedAgreementPrefill(db, 'w1', 'admin-1');

    expect(upserts).toHaveLength(1);
    const rows = upserts[0];
    expect(rows.map((r) => r.agreement_kind)).toEqual([
      'ic_agreement',
      'non_compete',
      'confidentiality_nda',
      'baa',
    ]);
    const ic = rows[0];
    expect(ic).toMatchObject({
      f_rate: '15000',
      f_position: 'QA Specialist',
      f_start_date: '2026-05-13',
      f_company_name: 'Aaron',
      f_employment_type: 'part_time',
      f_hours_per_week: 20,
      prepared_by: 'admin-1',
    });
    for (const r of rows.slice(1)) {
      expect(r.f_rate).toBeUndefined();
      expect(r.f_position).toBeUndefined();
      expect(r).toMatchObject({ f_company_name: 'Aaron', f_employment_type: 'part_time' });
    }
  });

  it('no-ops when any agreement row already exists (wizard-prepared)', async () => {
    const { db, upserts } = stub({
      existingAgreements: [{ worker_id: 'w1' }],
      worker: { hire_date: '2026-05-13' },
      links: [],
      rate: null,
    });
    await seedAgreementPrefill(db, 'w1', 'admin-1');
    expect(upserts).toHaveLength(0);
  });

  it('seeds nulls (not a crash) for a worker with no links or rate', async () => {
    const { db, upserts } = stub({ existingAgreements: [], worker: null, links: [], rate: null });
    await seedAgreementPrefill(db, 'w1', null);
    expect(upserts[0]?.[0]).toMatchObject({
      f_rate: null,
      f_position: null,
      f_start_date: null,
      f_company_name: null,
      f_employment_type: null,
    });
  });
});
