import type { ReactNode } from 'react';

/**
 * Hosts the `@modal` parallel slot alongside the page content so a soft
 * navigation to `/contractors/[workerId]` renders the intercept modal over the
 * list, while a hard navigation falls through to the full page.
 */
export default function ContractorsLayout({
  children,
  modal,
}: {
  children: ReactNode;
  modal: ReactNode;
}) {
  return (
    <>
      {children}
      {modal}
    </>
  );
}
