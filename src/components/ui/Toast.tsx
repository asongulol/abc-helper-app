'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export type ToastType = 'info' | 'success' | 'warn' | 'error';

export interface NotifyOptions {
  type?: ToastType;
  /** Auto-dismiss after this many milliseconds (legacy default ~5s). */
  ms?: number;
  /** Keep the toast until the user dismisses it. */
  persistent?: boolean;
}

interface ToastItem {
  id: number;
  content: ReactNode;
  type: ToastType;
}

interface ToastApi {
  notify: (content: ReactNode, opts?: NotifyOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Toast API — must be used under <ToastProvider> (mounted by AdminShell). */
export const useToast = (): ToastApi => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
};

/**
 * Floating pop-up notifications, port of the legacy `notify()` / <Toaster/>:
 * viewport-anchored so they are visible no matter how far the page scrolled.
 */
export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const toasterRef = useRef<HTMLElement>(null);

  // Toasts must paint above open native <dialog> modals. Those call showModal()
  // and live in the browser top layer, which z-index cannot beat — so a normal
  // toaster renders *behind* the modal. Promote the toaster into the top layer
  // via the popover API when the first toast appears, drop it when empty.
  // ponytail: shows once on 0→1; a toast fired while it's already open won't
  // re-promote above a modal opened *after* it. Upgrade: hide+show on each
  // change if that sequence ever bites (costs a focus jump, hence avoided here).
  useEffect(() => {
    const el = toasterRef.current;
    if (!el) return;
    const open = el.matches(':popover-open');
    if (toasts.length > 0 && !open) el.showPopover();
    else if (toasts.length === 0 && open) el.hidePopover();
  }, [toasts.length]);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (content: ReactNode, opts?: NotifyOptions): number => {
      nextId.current += 1;
      const id = nextId.current;
      setToasts((cur) => [...cur, { id, content, type: opts?.type ?? 'info' }]);
      if (!opts?.persistent) window.setTimeout(() => dismiss(id), opts?.ms ?? 5000);
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ notify, dismiss }), [notify, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section ref={toasterRef} className="toaster" popover="manual" aria-label="Notifications">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.type}`}
            role={t.type === 'error' || t.type === 'warn' ? 'alert' : 'status'}
          >
            <div style={{ flex: 1, minWidth: 0 }}>{t.content}</div>
            <button type="button" className="x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </section>
    </ToastContext.Provider>
  );
};
