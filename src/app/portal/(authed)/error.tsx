'use client';

import { RouteError } from '@/components/ui/RouteError';

/** Contractor-facing portal (RP-48) — a crash here reached a contractor bare. */
export default function PortalError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} scope="Your portal" />;
}
