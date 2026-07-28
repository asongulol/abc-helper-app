'use client';

import { RouteError } from '@/components/ui/RouteError';

/** Covers every admin route (RP-48) — /time, /payroll, /process and the rest. */
export default function AdminError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} scope="This page" />;
}
