import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { centavosToPhp, money } from '@/lib/format';

export interface MyWorkDuty {
  key: string;
  label: string;
  detail: string;
  href: string;
}

/**
 * B4 — capability-derived duties. There is no per-item assignment column in the
 * schema (see the design doc's Appendix A), so "mine" means "only this role can
 * do it": owner money duties (`requireOwner` gates staging/reconcile) and the
 * countersign queue (`admin_users.can_countersign`).
 *
 * A role with no exclusive duties gets an honest empty state, not a fake queue.
 */
export const buildDuties = (input: {
  isOwner: boolean;
  canCountersign: boolean;
  lockedUnpaid: { count: number; centavos: number };
  unconfirmedWise: { count: number; php: number };
  countersignPending: number;
  /** Period to send, when exactly one batch is locked and unpaid. */
  lockedPeriod: { id: string; start: string; end: string } | null;
}): MyWorkDuty[] => {
  const duties: MyWorkDuty[] = [];

  if (input.isOwner && input.lockedUnpaid.count > 0) {
    duties.push({
      key: 'send',
      label:
        input.lockedPeriod != null
          ? `Send ${input.lockedPeriod.start} → ${input.lockedPeriod.end}`
          : `Send ${input.lockedUnpaid.count} locked batches`,
      detail: `${money(centavosToPhp(input.lockedUnpaid.centavos), 'PHP')} locked, not yet sent`,
      href: input.lockedPeriod ? `/process?period=${input.lockedPeriod.id}` : '/process',
    });
  }

  if (input.isOwner && input.unconfirmedWise.count > 0) {
    duties.push({
      key: 'reconcile',
      label: `Reconcile ${input.unconfirmedWise.count} Wise ${input.unconfirmedWise.count === 1 ? 'link' : 'links'}`,
      detail: `${money(input.unconfirmedWise.php, 'PHP')} pointing at unconfirmed transfers`,
      href: '/batches',
    });
  }

  if (input.canCountersign && input.countersignPending > 0) {
    duties.push({
      key: 'countersign',
      label: `Countersign ${input.countersignPending} ${input.countersignPending === 1 ? 'agreement' : 'agreements'}`,
      detail: 'Signed by the contractor, waiting on you',
      href: '/onboarding',
    });
  }

  return duties;
};

export const MyWorkCard = ({ duties, isOwner }: { duties: MyWorkDuty[]; isOwner: boolean }) => (
  <section className="card ov-mywork" aria-labelledby="ov-mywork-h">
    <div className="ov-block-head">
      <h2 id="ov-mywork-h">My work</h2>
      <span className="sub" style={{ margin: 0 }}>
        {isOwner ? 'Owner-only actions' : 'Actions only you can take'}
      </span>
    </div>

    {duties.length === 0 ? (
      <EmptyState
        icon="✓"
        message={
          isOwner ? 'Nothing needs the owner right now.' : 'Nothing is assigned to you right now.'
        }
      />
    ) : (
      <ul className="ov-duty-list">
        {duties.map((d, idx) => (
          <li key={d.key} style={{ '--i': idx } as never}>
            <Link href={d.href} className="ov-duty">
              <span className="ov-duty-label">{d.label}</span>
              <span className="ov-duty-detail">{d.detail}</span>
              <span className="ov-duty-go" aria-hidden="true">
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    )}
  </section>
);
