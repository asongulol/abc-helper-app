import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import type { AttentionItem } from '@/lib/overview/attention';

/**
 * B3 — the dashboard's centre of gravity: one ranked, aged, linked row per
 * exception class (severity desc, then age desc).
 *
 * Rows are `<Link>`s in a list rather than table cells: the whole row is then a
 * real, focusable, middle-clickable target at any width (WCAG 2.5.8) with no
 * table→card CSS to maintain, and the age/count columns still line up on a grid.
 */
export const NeedsAttentionQueue = ({
  items,
  limit = 10,
}: {
  items: AttentionItem[];
  limit?: number;
}) => {
  const shown = items.slice(0, limit);
  const hidden = items.length - shown.length;

  return (
    <section className="card ov-queue" aria-labelledby="ov-queue-h">
      <div className="ov-block-head">
        <h2 id="ov-queue-h">
          Needs attention
          {items.length > 0 && <span className="ov-count-chip">{items.length}</span>}
        </h2>
        <span className="sub" style={{ margin: 0 }}>
          Ranked by severity, then age
        </span>
      </div>

      {shown.length === 0 ? (
        <EmptyState icon="✓" message="Nothing needs attention. Every exception class is clear." />
      ) : (
        <ul className="ov-q-list">
          {shown.map((it, idx) => (
            <li
              key={it.key}
              className={`ov-q-row s-${it.severity}`}
              style={{ '--i': idx } as never}
            >
              <Link href={it.href} className="ov-q-link">
                <span className="ov-q-icon" aria-hidden="true">
                  {it.icon}
                </span>
                <span className="ov-q-main">
                  <span className="ov-q-label">{it.label}</span>
                  {it.detail != null && <span className="ov-q-detail">{it.detail}</span>}
                </span>
                <span className="ov-q-count">
                  {it.count}
                  {it.amount != null && <span className="ov-q-amount">{it.amount}</span>}
                </span>
                <span className="ov-q-age">
                  {it.oldestDays != null ? `${it.oldestDays}d` : '—'}
                </span>
                <span className="ov-q-action">
                  {it.action}
                  <span aria-hidden="true">→</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {hidden > 0 && (
        <div className="sub" style={{ margin: '10px 0 0' }}>
          + {hidden} more {hidden === 1 ? 'class' : 'classes'} — open each surface for the full
          list.
        </div>
      )}
    </section>
  );
};
