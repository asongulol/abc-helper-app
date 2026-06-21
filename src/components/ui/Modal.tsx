'use client';

import { type MouseEvent, type ReactNode, useEffect, useId, useRef } from 'react';

export interface ModalProps {
  /** Optional heading; when set the dialog is labelled by it and gets a × close button. */
  title?: ReactNode;
  onClose: () => void;
  /** Close on Escape (legacy useModalA11y `escClose`). Default true. */
  escClose?: boolean;
  /** Cap the dialog width (legacy modals set inline maxWidth per use). */
  maxWidth?: number;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Shared modal dialog — port of the legacy `.modal-bg`/`.modal` pattern plus
 * the useModalA11y basics: initial focus, Tab focus trap, focus restore on
 * close, Escape-to-close, `aria-modal` + labelled heading. Click on the
 * backdrop closes; clicks inside do not.
 */
export const Modal = ({ title, onClose, escClose = true, maxWidth, children }: ModalProps) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    // Isolate the background: mark everything outside this dialog `inert` so neither
    // keyboard focus nor assistive tech can reach it (the manual Tab trap below stays
    // as a fallback). Walk up from .modal-bg and inert each ancestor's other children.
    const inerted: HTMLElement[] = [];
    for (
      let el: HTMLElement | null = node.parentElement;
      el && el !== document.body;
      el = el.parentElement
    ) {
      const parent = el.parentElement;
      if (!parent) break;
      for (const sib of Array.from(parent.children)) {
        if (sib !== el && sib instanceof HTMLElement && !sib.hasAttribute('inert')) {
          sib.setAttribute('inert', '');
          inerted.push(sib);
        }
      }
    }
    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
      );
    const first = focusables()[0];
    if (first) first.focus();
    else {
      node.setAttribute('tabindex', '-1');
      node.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (escClose) {
          e.preventDefault();
          e.stopPropagation();
          onCloseRef.current();
        }
        return;
      }
      if (e.key === 'Tab') {
        const els = focusables();
        const firstEl = els[0];
        const lastEl = els[els.length - 1];
        if (!firstEl || !lastEl) {
          e.preventDefault();
          return;
        }
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || !node.contains(active)) {
          e.preventDefault();
          firstEl.focus();
          return;
        }
        if (e.shiftKey && active === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && active === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      for (const el of inerted) el.removeAttribute('inert');
      try {
        prevFocus?.focus();
      } catch {
        /* trigger may be gone */
      }
    };
  }, [escClose]);

  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close; Escape handled above.
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay; keyboard users close via Escape (handled above) or the dialog's controls.
    <div className="modal-bg" onClick={() => onCloseRef.current()}>
      {/* IMPROVED: native <dialog> (legacy used a div with role="dialog"); kept
          always-open + manual focus trap so the legacy .modal CSS applies as-is. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops backdrop close only. */}
      <dialog
        open
        ref={ref}
        className="modal"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        onClick={stop}
        style={maxWidth != null ? { maxWidth } : undefined}
      >
        {title != null && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <h2 id={titleId} style={{ margin: 0 }}>
              {title}
            </h2>
            <button
              type="button"
              className="x"
              style={{ float: 'none' }}
              aria-label="Close"
              onClick={() => onCloseRef.current()}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        )}
        {children}
      </dialog>
    </div>
  );
};
