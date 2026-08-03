import Link from 'next/link';
import type { PipelineData } from '@/db/queries/overview';

interface PipelineStripProps {
  /** ISO period start — /time and /payroll deep-link by DATE. */
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
  /** Where the work for this stage happens. */
  href: string;
}

/** Active = the first stage that isn't done; everything after it is todo. */
const resolveStatus = (stages: Stage[], idx: number): StageStatus => {
  if (stages[idx]?.done) return 'done';
  return stages.findIndex((s) => !s.done) === idx ? 'active' : 'todo';
};

/**
 * Pay-cycle pipeline: Time → Approved → Calc → Lock → Sent.
 *
 * Two fixes over the original strip: a stage reads done only when it is
 * COMPLETE (partial approval shows "271 of 312", not a tick), and every stage
 * links to the surface that advances it. NOTE the deep-link asymmetry —
 * /payroll and /time take an ISO DATE, /process takes the period UUID.
 */
export const PipelineStrip = ({ periodStart, pipeline }: PipelineStripProps) => {
  const timeHref = `/time?start=${periodStart}`;
  const payrollHref = `/payroll?period=${periodStart}`;
  const processHref = pipeline.periodId ? `/process?period=${pipeline.periodId}` : '/process';

  const stages: Stage[] = [
    {
      key: 'time',
      label: 'Time',
      icon: '⏱',
      done: pipeline.timeImported.done,
      detail: pipeline.timeImported.detail,
      href: timeHref,
    },
    {
      key: 'approved',
      // NOT a tick: '✓' is what a COMPLETED stage renders, so an unstarted
      // Approved stage wearing one read as done at a glance.
      label: 'Approved',
      icon: '📝',
      done: pipeline.approved.done,
      detail: pipeline.approved.detail,
      href: timeHref,
    },
    {
      key: 'calc',
      label: 'Calc',
      icon: '🧮',
      done: pipeline.calculated.done,
      detail: pipeline.calculated.detail,
      href: payrollHref,
    },
    {
      key: 'lock',
      label: 'Lock',
      icon: '🔒',
      done: pipeline.locked.done,
      detail: pipeline.locked.detail,
      href: payrollHref,
    },
    {
      key: 'sent',
      label: 'Sent',
      icon: '✉',
      done: pipeline.paid.done,
      detail: pipeline.paid.detail,
      href: processHref,
    },
  ];

  return (
    <ol className="ov-pipe" aria-label="Pay cycle progress">
      {stages.map((stage, idx) => {
        const status = resolveStatus(stages, idx);
        return (
          <li key={stage.key} className={`ov-pipe-step ${status}`} style={{ '--i': idx } as never}>
            <Link href={stage.href} className="ov-pipe-link">
              <span className="ov-pipe-pip" aria-hidden="true">
                {status === 'done' ? '✓' : stage.icon}
              </span>
              <span className="ov-pipe-label">{stage.label}</span>
              <span className="ov-pipe-sub">{stage.detail ?? '—'}</span>
              <span className="ov-sr-only">{`: ${status === 'done' ? 'complete' : status === 'active' ? 'in progress' : 'not started'}`}</span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
};
