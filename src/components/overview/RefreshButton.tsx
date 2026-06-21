'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/**
 * Overview "Refresh" control. Unlike a <Link href="/overview">, which the App
 * Router can satisfy from its client cache (a no-op when already on /overview),
 * router.refresh() re-runs the server component and re-fetches its data — so the
 * "updated just now" stamp is honest.
 */
export const RefreshButton = () => {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="btn ghost sm"
      onClick={() => startTransition(() => router.refresh())}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? '↻ Refreshing…' : '↻ Refresh'}
    </button>
  );
};
