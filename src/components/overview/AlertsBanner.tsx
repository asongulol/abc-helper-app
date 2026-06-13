import type { AlertItem } from '@/db/queries/overview';

interface AlertsBannerProps {
  alerts: AlertItem[];
}

const ALERT_LABELS: Record<AlertItem['kind'], string> = {
  no_rate: 'No rate',
  no_payout_method: 'No payout method',
};

/**
 * Overview alerts banner — shows a `.banner` for each category of alert.
 * Renders nothing when there are no alerts.
 */
export const AlertsBanner = ({ alerts }: AlertsBannerProps) => {
  if (alerts.length === 0) return null;

  const noRate = alerts.filter((a) => a.kind === 'no_rate');
  const noMethod = alerts.filter((a) => a.kind === 'no_payout_method');

  return (
    <div style={{ marginBottom: 16 }}>
      {noRate.length > 0 && (
        <div className="banner" role="alert">
          <strong>⚠ {ALERT_LABELS.no_rate}:</strong> {noRate.map((a) => a.workerName).join(', ')} ha
          {noRate.length === 1 ? 's' : 've'} approved time but no effective rate this period.
        </div>
      )}
      {noMethod.length > 0 && (
        <div className="banner" role="alert" style={{ marginTop: noRate.length > 0 ? 8 : 0 }}>
          <strong>⚠ {ALERT_LABELS.no_payout_method}:</strong>{' '}
          {noMethod.map((a) => a.workerName).join(', ')} ha
          {noMethod.length === 1 ? 's' : 've'} payment rows missing a payout method.
        </div>
      )}
    </div>
  );
};
