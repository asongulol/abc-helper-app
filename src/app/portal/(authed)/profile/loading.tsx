import { Spinner } from '@/components/ui';

export default function PortalProfileLoading() {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 40 }}>
      <Spinner />
    </div>
  );
}
