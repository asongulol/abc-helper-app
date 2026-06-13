import { Spinner } from '@/components/ui';

export default function PortalOnboardingLoading() {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 40 }}>
      <Spinner />
    </div>
  );
}
