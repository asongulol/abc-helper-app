import type { PipelineData } from '@/db/queries/overview';
import { fmtDate } from '@/lib/format';

interface PipelineStripProps {
  periodStart: string;
  periodEnd: string;
  pipeline: PipelineData;
}

type StageStatus = 'done' | 'active' | 'todo';

interface Stage {
  key: string;
  label: string;
  icon: string;
  done: boolean;
  detail: string | null;
}

/** Resolve which stage is currently active (first undone stage). */
const resolveStatus = (stages: Stage[], idx: number): StageStatus => {
  if (stages[idx]?.done) return 'done';
  // Active = first undone stage
  const firstUndone = stages.findIndex((s) => !s.done);
  return firstUndone === idx ? 'active' : 'todo';
};

/**
 * Pay-cycle pipeline strip — maps the five stages (time-imported → approved →
 * calculated → locked → paid) to the .ov-pipe CSS classes.
 */
export const PipelineStrip = ({ periodStart, periodEnd, pipeline }: PipelineStripProps) => {
  const stages: Stage[] = [
    {
      key: 'time',
      label: 'Time\nImported',
      icon: '⏱',
      done: pipeline.timeImported.done,
      detail: pipeline.timeImported.detail,
    },
    {
      key: 'approved',
      label: 'Approved',
      icon: '✓',
      done: pipeline.approved.done,
      detail: pipeline.approved.detail,
    },
    {
      key: 'calculated',
      label: 'Calculated',
      icon: '🧮',
      done: pipeline.calculated.done,
      detail: pipeline.calculated.detail,
    },
    {
      key: 'locked',
      label: 'Locked',
      icon: '🔒',
      done: pipeline.locked.done,
      detail: pipeline.locked.detail,
    },
    {
      key: 'paid',
      label: 'Paid',
      icon: '💸',
      done: pipeline.paid.done,
      detail: pipeline.paid.detail,
    },
  ];

  return (
    <div className="ov-cycle">
      <div className="ov-cycle-head">
        <div>
          <div className="ov-tile-label" style={{ marginBottom: 2 }}>
            Current period
          </div>
          <strong>
            {fmtDate(periodStart)} – {fmtDate(periodEnd)}
          </strong>
        </div>
      </div>
      <div className="ov-pipe">
        {stages.map((stage, idx) => {
          const status = resolveStatus(stages, idx);
          return (
            <div key={stage.key} className={`ov-pipe-step ${status}`}>
              <div className="ov-pipe-pip" aria-label={`${stage.label}: ${status}`}>
                {status === 'done' ? '✓' : stage.icon}
              </div>
              <div className="ov-pipe-label" style={{ whiteSpace: 'pre-line' }}>
                {stage.label}
              </div>
              {stage.detail != null && <div className="ov-pipe-sub">{stage.detail}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
};
