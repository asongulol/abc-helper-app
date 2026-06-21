/**
 * Pure frequency gate for the hiring-review digest (no I/O, trivially testable).
 *
 * The cron fires daily (migration 0016, 21:15 UTC); this decides which of those
 * daily ticks actually emails, per the admin's `reminders.frequency` setting
 * (Configuration → Onboarding → "🔔 Document-review reminders"):
 *
 *   - daily    → every day
 *   - weekdays → Monday–Friday (UTC)
 *   - weekly   → Monday only (UTC)
 *
 * Day-of-week is evaluated in UTC to match the UTC cron schedule. An unrecognized
 * value fails OPEN (sends, treated as daily) so a malformed config never silently
 * suppresses the digest.
 */
export const shouldSendDigestToday = (frequency: string, today: Date): boolean => {
  const dow = today.getUTCDay(); // 0=Sun … 6=Sat
  if (frequency === 'weekdays') return dow >= 1 && dow <= 5;
  if (frequency === 'weekly') return dow === 1; // Monday
  return true; // 'daily' or anything unrecognized
};
