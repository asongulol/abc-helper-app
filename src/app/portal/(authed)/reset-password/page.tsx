import type { Metadata } from 'next';
import { PortalResetPassword } from '@/components/portal/PortalResetPassword';

export const metadata: Metadata = { title: 'Set Password — Contractor Portal' };

export default function PortalResetPasswordPage() {
  return <PortalResetPassword />;
}
