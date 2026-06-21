import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/db/clients/server';
import type { OnboardingProgressRow } from '@/db/queries/onboarding';
import { fetchOnboardingProgressByWorker } from '@/db/queries/onboarding';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';

export interface OnboardingPageData {
  row: OnboardingProgressRow;
  canCountersign: boolean;
  isOwner: boolean;
}

/**
 * Loads a single contractor's onboarding-progress row, shared by the full-page
 * route and its intercept-modal counterpart. Redirects to login when not an
 * admin; returns null when there's no onboarding row for the worker (caller
 * renders notFound()). RLS scopes visibility to the admin's companies.
 */
export async function loadOnboarding(workerId: string): Promise<OnboardingPageData | null> {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const companyId = await getSelectedCompanyId();
  if (!companyId) return null;

  const db = await createServerSupabase();
  const row = await fetchOnboardingProgressByWorker(db, workerId);
  if (!row) return null;

  return { row, canCountersign: admin.canCountersign, isOwner: admin.isOwner };
}
