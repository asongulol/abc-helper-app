import Link from 'next/link';
import type { AttentionItem } from '@/lib/overview/attention';

/**
 * B2 — the critical band. Only classes that carry a `banner` sentence appear
 * here (money is wrong, or a pay-date deadline is at hand); everything else
 * lives in the queue below. Each banner is a link to the surface that fixes it,
 * so the alert and the remedy are one click apart.
 *
 * `role="alert"` is kept for content present at first paint (the previous
 * banner did the same); banners that appear only after a Refresh announce via
 * the polite live region instead of interrupting.
 */
export const AlertsBanner = ({ items }: { items: AttentionItem[] }) => {
  if (items.length === 0) return null;

  return (
    // role="alert" belongs on the CONTAINER: putting it on the <a> would
    // override the link role and cost assistive tech the "link" announcement.
    <div className="ov-alerts" role="alert">
      {items.map((it, idx) => (
        <Link
          key={it.key}
          href={it.href}
          className={`banner ov-banner ${it.severity === 'critical' ? 'error' : ''}`}
          style={{ '--i': idx } as never}
        >
          <span>{it.banner}</span>
          <span className="ov-banner-go" aria-hidden="true">
            →
          </span>
        </Link>
      ))}
    </div>
  );
};
