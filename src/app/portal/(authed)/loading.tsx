import { Spinner } from '@/components/ui';

/**
 * Portal home skeleton. Without it, navigating to the contractor landing page
 * leaves the previous page frozen until its ~7 queries resolve; this paints an
 * instant fallback. Mirrors the other portal route loadings (Spinner in a card).
 */
export default function PortalHomeLoading() {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 40 }}>
      <Spinner />
    </div>
  );
}
