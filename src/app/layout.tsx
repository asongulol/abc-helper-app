import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// The stylesheet asked for Inter but nothing ever loaded it, so the app fell
// through to system-ui — rendering in SF on macOS and Segoe on Windows. Inter
// stays the choice (it is a UI face with real tabular figures, which a payroll
// screen leans on); it is now actually served. next/font self-hosts it, so
// there is no third-party request, and the generated size-adjusted fallback
// keeps the swap from shifting layout.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'HR & Payroll — PH Contractors',
  description: 'Aaron Anderson E.H.S. LLC payroll — Hubstaff time → PHP payouts via Wise.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
