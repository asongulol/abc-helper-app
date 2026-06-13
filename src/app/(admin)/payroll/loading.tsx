import { Spinner } from '@/components/ui';

export default function PayrollLoading() {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 48 }}>
      <Spinner />
      <p className="sub" style={{ marginTop: 12 }}>
        Loading payroll…
      </p>
    </div>
  );
}
