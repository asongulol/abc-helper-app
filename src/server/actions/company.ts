'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { requireAdmin } from '@/server/auth/admin';
import { COMPANY_COOKIE } from '@/server/company';

/** Switch the admin's working company (legacy: header company switcher). */
export async function selectCompany(companyId: string): Promise<void> {
  await requireAdmin();
  const cookieStore = await cookies();
  cookieStore.set(COMPANY_COOKIE, companyId, { path: '/', sameSite: 'lax' });
  revalidatePath('/', 'layout');
}
