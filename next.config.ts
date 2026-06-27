import type { NextConfig } from 'next';

// Build stamp shown in the admin footer (see src/components/shell/AdminShell.tsx).
// On Vercel, VERCEL_GIT_COMMIT_SHA is injected at build time; fall back to a
// `local` marker for `next dev` / non-Vercel builds. Format mirrors the legacy
// "<date> · <sha>" stamp so the footer reflects the actual deployed commit
// instead of a hardcoded placeholder.
const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7);
const builtAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
const buildStamp = `${builtAt} UTC · ${sha || 'local'}`;

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD: buildStamp,
  },
};

export default nextConfig;
