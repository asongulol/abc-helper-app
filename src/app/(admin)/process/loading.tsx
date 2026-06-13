import { Spinner } from '@/components/ui';

export default function ProcessLoading() {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 48 }}>
      <Spinner />
      <p className="sub" style={{ marginTop: 12 }}>
        Loading process & pay…
      </p>
    </div>
  );
}
