import type { NextConfig } from 'next';

// Build stamp shown in the admin footer (see src/components/shell/AdminShell.tsx).
// On Vercel, VERCEL_GIT_COMMIT_SHA is injected at build time; fall back to a
// `local` marker for `next dev` / non-Vercel builds. Format mirrors the legacy
// "<date> · <sha>" stamp so the footer reflects the actual deployed commit
// instead of a hardcoded placeholder.
const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7);
// Eastern time (sv-SE locale formats as "YYYY-MM-DD HH:mm"); EDT/EST label
// comes from the zone itself so the stamp stays honest across DST.
const now = new Date();
const builtAt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}).format(now);
const tzAbbr =
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'ET';
const buildStamp = `${builtAt} ${tzAbbr} · ${sha || 'local'}`;

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD: buildStamp,
  },
};

export default nextConfig;
