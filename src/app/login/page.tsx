import type { Metadata } from 'next';
import { AdminLoginForm } from '@/components/auth/AdminLoginForm';
import { Logo } from '@/components/brand/Logo';

export const metadata: Metadata = { title: 'Sign in — HR & Payroll' };

const ERROR_MESSAGES: Record<string, string> = {
  domain:
    'That Google account isn’t on an approved work domain. Sign in with your company Google account.',
  oauth: 'Sign-in didn’t complete. Please try again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message = error ? ERROR_MESSAGES[error] : null;

  return (
    <div className="connect">
      <div className="card">
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <Logo height={150} priority />
        </div>
        <h2>Sign in</h2>
        <p className="sub">Sign in with your Google account to access the payroll app.</p>
        {message && (
          <div
            className="banner error"
            style={{ marginBottom: 16, textAlign: 'left' }}
            role="alert"
          >
            {message}
          </div>
        )}
        <AdminLoginForm />
      </div>
    </div>
  );
}
