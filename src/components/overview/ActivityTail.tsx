import Link from 'next/link';
import type { AuditLogRow } from '@/db/queries/audit';

const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Manila',
});

/** `wise_attribute_undo` → "Wise attribute undo". */
const humanAction = (action: string): string => {
  const words = action.replace(/[._]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * B7 — the tail of the append-only `audit_log`. Cheap trust-builder: it answers
 * "what just changed, and who did it" without leaving the dashboard, and links
 * into /audit for the rest. Detail payloads are deliberately not rendered —
 * they can carry row-level specifics the tail has no business displaying.
 */
export const ActivityTail = ({ rows }: { rows: AuditLogRow[] }) => (
  <section className="card ov-activity" aria-labelledby="ov-activity-h">
    <div className="ov-block-head">
      <h2 id="ov-activity-h">Recent activity</h2>
      <Link className="btn ghost sm" href="/audit">
        Open audit log
      </Link>
    </div>

    {rows.length === 0 ? (
      <div className="sub" style={{ margin: 0 }}>
        No recorded activity yet.
      </div>
    ) : (
      <ul className="ov-act-list">
        {rows.map((r, idx) => (
          <li key={r.id} style={{ '--i': idx } as never}>
            <time className="ov-act-when" dateTime={r.createdAt}>
              {TIME_FMT.format(new Date(r.createdAt))}
            </time>
            <span className="ov-act-what">{humanAction(r.action)}</span>
            {r.entity != null && <span className="ov-act-entity">{r.entity}</span>}
            <span className="ov-act-who">{r.actor ?? 'system'}</span>
          </li>
        ))}
      </ul>
    )}
  </section>
);
