'use client';

import { useEffect } from 'react';

export interface UseUnsavedGuardOptions {
  /** When true, leaving the page triggers the browser's native confirm prompt. */
  dirty: boolean;
  /** In-component confirm copy for a guarded close (browser-native confirm()). */
  message?: string | undefined;
}

const DEFAULT_MESSAGE = 'You have unsaved changes. Leave and lose them?';

/**
 * Unsaved-changes guard for client surfaces (modals, wizards, edit panels).
 *
 * Registers a `beforeunload` handler whenever `dirty` is true so a tab close /
 * reload / external navigation surfaces the browser's native warning. App Router
 * cannot intercept `<Link>` client navigations, so this only covers the
 * unload path — in-component closes should call the returned `confirmDiscard()`
 * before invoking their own `onClose`.
 *
 * Returns `confirmDiscard()`: when not dirty it returns true immediately;
 * when dirty it shows a `window.confirm` and returns the user's choice.
 */
export function useUnsavedGuard({ dirty, message }: UseUnsavedGuardOptions): () => boolean {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require returnValue to be set to trigger the prompt.
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  return () => {
    if (!dirty) return true;
    if (typeof window === 'undefined') return true;
    return window.confirm(message ?? DEFAULT_MESSAGE);
  };
}
