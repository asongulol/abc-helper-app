'use client';

/**
 * Off-cycle catch-up card for the Time page — appears only when the viewed
 * period is already locked/paid AND a salaried (FT/PT) contractor has approved
 * hours the run never paid. One click routes the leftover to the open
 * off-cycle batch, priced by the engine's strict cap (same math as the
 * payroll modal's Catch-up tab; amounts recomputed server-side).
 */

import { useEffect, useState, useTransition } from 'react';
import { Badge, useToast } from '@/components/ui';
import { peso } from '@/lib/format';
import { centavosToPhp } from '@/lib/payroll/mappers';
import {
  addSalariedCatchUp,
  getSalariedCatchUpCandidates,
  openOffCycleBatch,
} from '@/server/actions/payroll';
import type { CatchUpCandidate } from '@/server/payroll';

interface Props {
  companyId: string;
  /** The period currently shown by the Time page picker. */
  periodStart: string;
  /** Bumped by the parent after approvals so the leftovers refresh. */
  refreshKey?: number;
}

export function OffCycleCatchUpCard({ companyId, periodStart, refreshKey = 0 }: Props) {
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();
  const [data, setData] = useState<{
    period: { id: string; periodStart: string; periodEnd: string } | null;
    candidates: CatchUpCandidate[];
  } | null>(null);
  const [version, setVersion] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies(refreshKey): refetch signal from the parent
  // biome-ignore lint/correctness/useExhaustiveDependencies(version): refetch counter — bumped after an add
  useEffect(() => {
    let live = true;
    getSalariedCatchUpCandidates({ companyId, periodDate: periodStart }).then((res) => {
      if (!live) return;
      if (res.ok) setData({ period: res.data.period, candidates: res.data.candidates });
    });
    return () => {
      live = false;
    };
  }, [companyId, periodStart, refreshKey, version]);

  const leftovers = (data?.candidates ?? []).filter((c) => c.leftoverHours > 0);
  if (!data?.period || leftovers.length === 0) return null;

  const handleAdd = (c: CatchUpCandidate) => {
    startTransition(async () => {
      // Land the catch-up on the employer's open off-cycle batch (created on
      // demand) — the viewed period is locked, so it can't take the pay itself.
      const batch = await openOffCycleBatch({ companyId });
      if (!batch.ok) {
        notify(batch.error, { type: 'error' });
        return;
      }
      const res = await addSalariedCatchUp({
        companyId,
        periodStart: batch.data.periodStart,
        periodEnd: batch.data.periodEnd,
        workerId: c.workerId,
        originalPeriodDate: periodStart,
        hours: c.leftoverHours,
      });
      if (res.ok) {
        notify(
          `${c.name}: ${c.leftoverHours}h routed to the off-cycle batch (${peso(res.data.amountPhp)}).`,
          { type: 'success' },
        );
        setVersion((v) => v + 1);
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <div>
          <h3 style={{ margin: 0 }}>Off-cycle catch-up (FT/PT)</h3>
          <p className="sub" style={{ margin: '4px 0 0' }}>
            This period is locked, so approved hours below were never paid by its run. Route the
            leftover to the open off-cycle batch — priced exactly as the run would have (capped at
            100% of the period rate).
          </p>
        </div>
      </div>
      {leftovers.map((c) => (
        <div
          key={c.workerId}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            padding: '6px 0',
            borderTop: '1px solid var(--border)',
          }}
        >
          <span style={{ flex: 1, minWidth: 160, fontSize: 13 }}>
            {c.name} <span className="muted">({c.contract})</span>
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            {c.leftoverHours}h left · {c.paidHours}h paid of {c.expectedHours}h
            {c.caughtUpHours > 0 ? ` · ${c.caughtUpHours}h caught up` : ''}
          </span>
          <Badge tone={c.amountCentavos ? 'warn' : 'neutral'}>
            {c.amountCentavos === null ? 'no rate' : peso(centavosToPhp(c.amountCentavos))}
          </Badge>
          <button
            type="button"
            className="btn sm"
            disabled={isPending || c.amountCentavos === null || c.amountCentavos === 0}
            onClick={() => handleAdd(c)}
          >
            {isPending ? 'Adding…' : 'Add to off-cycle batch'}
          </button>
        </div>
      ))}
    </div>
  );
}
