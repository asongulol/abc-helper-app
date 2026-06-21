/**
 * The `@modal` slot renders nothing by default — only when an intercept route
 * matches (soft navigation to `/onboarding/[workerId]`). On hard navigation
 * Next.js falls back to this, so no modal appears over the full page.
 */
export default function ModalDefault() {
  return null;
}
