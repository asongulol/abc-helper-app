import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

/** Small labeled field wrapper, matching the legacy .field pattern. */
export function Field({
  id,
  label,
  required,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string | undefined;
  children: ReactNode;
}) {
  const errId = `${id}-err`;
  // Link the control to its error so screen readers announce it, and flag it
  // invalid. The control is passed as children, so clone it to inject the ARIA.
  const control =
    error != null && isValidElement(children)
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          'aria-describedby': errId,
          'aria-invalid': true,
        })
      : children;
  return (
    <div className="field">
      <label htmlFor={id} style={{ textTransform: 'uppercase', letterSpacing: '.02em' }}>
        {label}
        {required && <span className="req"> *</span>}
      </label>
      {control}
      {error != null && (
        <div className="field-err" id={errId}>
          {error}
        </div>
      )}
    </div>
  );
}
