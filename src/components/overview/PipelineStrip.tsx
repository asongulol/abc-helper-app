import type { PipelineData } from '@/db/queries/overview';

interface PipelineStripProps {
  /** Period bounds — kept for call-site parity; the cycle header is rendered by the page. */
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
export const PipelineStrip = ({ pipeline }: PipelineStripProps) => {
  const stages: Stage[] = [
    {
      key: 'time',
      label: 'Time',
      icon: '⏱',
      done: pipeline.approved.done,
      detail: 'approved',
    },
    {
      key: 'calc',
      label: 'Calc',
      icon: '🧮',
      done: pipeline.calculated.done,
      detail: pipeline.calculated.detail ?? "calc'd",
    },
    {
      key: 'lock',
      label: 'Lock',
      icon: '🔒',
      done: pipeline.locked.done,
      detail: 'locked',
    },
    {
      key: 'sent',
      label: 'Sent',
      icon: '✉',
      done: pipeline.paid.done,
      detail: pipeline.paid.detail ?? 'sent',
    },
    {
      key: 'settled',
      label: 'Settled',
      icon: '✓',
      done: pipeline.periodState === 'paid',
      detail: 'done',
    },
  ];

  return (
    <ul className="ov-pipe" aria-label="Pay cycle progress">
      {stages.map((stage, idx) => {
        const status = resolveStatus(stages, idx);
        return (
          <li key={stage.key} className={`ov-pipe-step ${status}`}>
            <div className="ov-pipe-pip" aria-label={`${stage.label}: ${status}`}>
              {status === 'done' ? '✓' : stage.icon}
            </div>
            <div className="ov-pipe-label">{stage.label}</div>
            {stage.detail != null && <div className="ov-pipe-sub">{stage.detail}</div>}
          </li>
        );
      })}
    </ul>
  );
};
