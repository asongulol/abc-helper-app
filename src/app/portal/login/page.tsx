import { PortalLoginForm } from '@/components/auth/PortalLoginForm';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sign in — Contractor Portal' };

/** Brand mark (same navy/gold artwork as the favicon). */
const BrandMark = () => (
  <svg
    viewBox="0 0 64 64"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    style={{ width: 64, height: 64, margin: '0 auto 10px', display: 'block' }}
  >
    <rect width="64" height="64" rx="14" fill="#1F3A68" />
    <path d="M13 47 L21 26 L29 47 Z" fill="#D4A24C" />
    <path d="M23 47 L32 20 L41 47 Z" fill="#F2C879" />
    <path d="M35 47 L43 26 L51 47 Z" fill="#D4A24C" />
    <path
      d="M11 45 Q32 34 53 45"
      stroke="#D4A24C"
      strokeWidth="3"
      fill="none"
      strokeLinecap="round"
    />
  </svg>
);

export default function PortalLoginPage() {
  return (
    <div className="portal">
      <div className="wrap">
        <div style={{ textAlign: 'center', margin: '32px 0 8px' }}>
          <BrandMark />
          <h2 style={{ margin: 0 }}>Contractor Portal</h2>
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
