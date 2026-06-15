'use client';

import { useEffect } from 'react';

/**
 * Opens the browser print dialog once on mount (print routes are opened in a
 * new tab from the originating screen), plus a manual button for re-printing.
 * `.no-print` keeps the button itself out of the printed page.
 *
 * Shared by every print route (invoicing, pay slips, agreements). The
 * invoicing route re-exports this from `@/components/invoicing/AutoPrint`.
 */
export function AutoPrint() {
  useEffect(() => {
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, []);

  return (
    <button
      type="button"
      className="btn ghost sm no-print"
      style={{ marginBottom: 16 }}
      onClick={() => window.print()}
    >
      Print
    </button>
  );
}
