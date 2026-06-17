'use client';

/**
 * Period picker: prev / current label / next navigation for semi-monthly periods.
 * The active period is passed from the parent; this component just fires callbacks.
 */

import type { PayPeriod } from '@/lib/dates/periods';
import { isoToUtcMs, periodFor, utcMsToIso } from '@/lib/dates/periods';

interface PeriodPickerProps {
  period: PayPeriod;
  onChange: (p: PayPeriod) => void;
  disabled?: boolean;
}

const DAY_MS = 86_400_000;

export const PeriodPicker = ({ period, onChange, disabled = false }: PeriodPickerProps) => {
  const goPrev = () => {
    const prevDay = utcMsToIso(isoToUtcMs(period.start) - DAY_MS);
    onChange(periodFor(prevDay));
  };

  const goNext = () => {
    const nextDay = utcMsToIso(isoToUtcMs(period.end) + DAY_MS);
    onChange(periodFor(nextDay));
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        className="btn ghost sm"
        onClick={goPrev}
        disabled={disabled}
        aria-label="Previous period"
      >
        ‹ Prev
      </button>
      <span style={{ fontWeight: 600, fontSize: 13 }}>
        {period.start} – {period.end}
      </span>
      <button
        type="button"
        className="btn ghost sm"
        onClick={goNext}
        disabled={disabled}
        aria-label="Next period"
      >
        Next ›
      </button>
    </div>
  );
};
