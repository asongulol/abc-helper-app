import { AdminLoginForm } from '@/components/auth/AdminLoginForm';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sign in — HR & Payroll' };

/** Brand mark (same artwork as the favicon / legacy logo). */
const BrandMark = () => (
  <svg
    className="brand-mark"
    viewBox="0 0 64 64"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
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

export default function LoginPage() {
  return (
    <div className="connect">
      <div className="card">
        <BrandMark />
        <h2>Sign in</h2>
        <p className="sub">Sign in with your Google account to access the payroll app.</p>
        <AdminLoginForm />
      </div>
    </div>
  );
}
