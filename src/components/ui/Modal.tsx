'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';

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

/**
 * Shared modal dialog — a native <dialog> promoted to the browser **top layer**
 * via showModal(). The top layer is what makes nested modals stack correctly: a
 * child Modal renders above its parent and dims it, escaping any ancestor
 * overflow/stacking context (a plain `<dialog open>` could not). It also gives
 * native focus trapping, focus restore on close, background inertness, and
 * Escape handling for free. Backdrop click closes; clicks inside the card do not.
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
    // Promote to the top layer (above any parent modal, escaping ancestor
    // overflow/stacking) — the key win over a plain <dialog open>.
    if (!node.open) node.showModal();

    // Escape fires `cancel`; take it over so the parent decides what "close"
    // means (e.g. an unsaved-changes guard) rather than the dialog closing itself.
    const onCancel = (e: Event) => {
      e.preventDefault();
      if (escClose) onCloseRef.current();
    };
    // Backdrop click closes — but only when both press and release land outside
    // the card, so a text selection that drags onto the backdrop doesn't close it.
    let pressedOutside = false;
    const isOutside = (e: MouseEvent) => {
      const r = node.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    const onDown = (e: MouseEvent) => {
      pressedOutside = e.target === node && isOutside(e);
    };
    const onClick = (e: MouseEvent) => {
      if (pressedOutside && e.target === node && isOutside(e)) onCloseRef.current();
      pressedOutside = false;
    };
    node.addEventListener('cancel', onCancel);
    node.addEventListener('mousedown', onDown);
    node.addEventListener('click', onClick);
    return () => {
      node.removeEventListener('cancel', onCancel);
      node.removeEventListener('mousedown', onDown);
      node.removeEventListener('click', onClick);
      if (node.open) node.close();
    };
  }, [escClose]);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={title != null ? titleId : undefined}
      style={maxWidth != null ? { maxWidth } : undefined}
    >
      {title != null && (
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="x"
            aria-label="Close"
            onClick={() => onCloseRef.current()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
      {children}
    </dialog>
  );
};
