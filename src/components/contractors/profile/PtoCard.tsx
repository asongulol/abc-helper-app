'use client';

/**
 * PTO accrued / used / balance per year (docs/CONTRACT-CHANGE-WIZARD-PLAN.md
 * decision 7). Reference only — Calculate never reads it. Self-loading like
 * RateCard so it sits outside the profile form.
 */

import { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui';
import { hours } from '@/lib/format';
import { ACCRUAL_DAYS, BALANCE_CEILING_DAYS, FULL_TIME_HOURS } from '@/lib/pay/pto';
import { getPtoBalance, type PtoBalance } from '@/server/actions/contracts';

const days = (n: number): string => `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}d`;

export function PtoCard({ workerId, companyId }: { workerId: string; companyId: string }) {
  const [data, setData] = useState<PtoBalance | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    getPtoBalance({ workerId, companyId }).then((res) => {
      if (!live) return;
      if (res.ok) setData(res.data);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [workerId, companyId]);

  if (error) return <p className="sub">{error}</p>;
  if (!data) return <Spinner />;
  const latest = data.years.at(-1);
  return (
    <div>
      <p style={{ margin: '0 0 8px' }}>
        Balance <strong>{latest ? days(latest.balanceDays) : '—'}</strong>
        <span className="muted" style={{ fontSize: 12 }}>
          {' '}
          · {ACCRUAL_DAYS} days per {FULL_TIME_HOURS.toLocaleString('en-US')} approved hours, capped
          at {data.capDays} a year · carries over up to {BALANCE_CEILING_DAYS} days · reference only
        </span>
      </p>
      {data.years.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Year</th>
                <th>Approved hours</th>
                <th>Carried in</th>
                <th>Accrued</th>
                <th>Used</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {[...data.years].reverse().map((y) => (
                <tr key={y.year}>
                  <td>{y.year}</td>
                  <td>{hours(y.trackedHours)}</td>
                  <td>{days(y.carriedInDays)}</td>
                  <td>{days(y.accruedDays)}</td>
                  <td>{days(y.usedDays)}</td>
                  <td style={y.balanceDays < 0 ? { color: 'var(--bad)' } : undefined}>
                    {days(y.balanceDays)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
