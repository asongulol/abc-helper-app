/**
 * True for a Next.js App Router prefetch RSC request. Next fires one of these per
 * `<Link>` rendered on a page (full-route prefetch sets `next-router-prefetch: 1`;
 * PPR/segment prefetch sets `next-router-segment-prefetch`). The proxy uses this
 * to skip the auth gate on prefetches — see src/proxy.ts. Header names verified
 * against next 16.2 (client/components/app-router-headers).
 */
export const isPrefetchRequest = (headers: Headers): boolean =>
  headers.get('next-router-prefetch') === '1' || headers.has('next-router-segment-prefetch');
