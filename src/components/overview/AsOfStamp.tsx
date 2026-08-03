/**
 * Honest freshness stamp. The old header rendered the literal string
 * "updated just now" beside the Refresh button — a claim that was false the
 * moment the tab sat open. This renders the actual server render time instead,
 * so it visibly changes when Refresh re-runs the server components.
 *
 * Zero client JS. Asia/Manila is the app's operational day boundary (time
 * import, pay dates), and the zone is labelled so the number can't be misread.
 */

const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Manila',
});

export const AsOfStamp = ({ at = new Date() }: { at?: Date }) => (
  <span className="ov-updated" title="Server render time — press Refresh to re-read">
    <span className="dot" aria-hidden="true" />
    as of {TIME_FMT.format(at)} PHT
  </span>
);
