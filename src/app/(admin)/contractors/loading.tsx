import { Spinner } from '@/components/ui';

export default function ContractorsLoading() {
  return (
    <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 32 }}>
      <Spinner />
      <span className="muted">Loading contractors…</span>
    </div>
  );
}
