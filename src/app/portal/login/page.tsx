import { PortalLoginForm } from '@/components/auth/PortalLoginForm';
import { Logo } from '@/components/brand/Logo';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sign in — Contractor Portal' };

export default function PortalLoginPage() {
  return (
    <div className="portal">
      <div className="wrap">
        <div style={{ textAlign: 'center', margin: '32px 0 8px' }}>
          <Logo height={52} priority />
          <h2 style={{ margin: '10px 0 0' }}>Contractor Portal</h2>
          <p className="sub">Sign in to view your pay, time, and documents.</p>
        </div>
        <PortalLoginForm />
        <p className="sub" style={{ textAlign: 'center' }}>
          Trouble signing in? Contact your payroll admin.
        </p>
      </div>
    </div>
  );
}
