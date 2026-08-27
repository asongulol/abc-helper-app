'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { requireAdmin } from '@/server/auth/admin';
import { CLIENTS_COOKIE } from '@/server/company';
import { uuid } from '@/types/schemas/uuid';

/** Set the header CLIENT filter (multi-select). Empty array = all clients. */
export async function selectClients(clientIds: string[]): Promise<void> {
  await requireAdmin();
  const ids = clientIds.filter((id) => uuid().safeParse(id).success);
  const cookieStore = await cookies();
  if (ids.length === 0) cookieStore.delete(CLIENTS_COOKIE);
  else cookieStore.set(CLIENTS_COOKIE, ids.join(','), { path: '/', sameSite: 'lax' });
  revalidatePath('/', 'layout');
}
